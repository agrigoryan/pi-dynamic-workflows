import { type Node, parse } from "acorn";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

export interface ParsedWorkflow {
  meta: WorkflowMeta;
  /** Script body with the meta export removed, ready to wrap in an async IIFE. */
  body: string;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

const NONDETERMINISM_ERROR =
  "Workflow scripts must be deterministic: Date.now(), Math.random(), and new Date() are unavailable. " +
  "Pass timestamps in via args and stamp results after the workflow returns.";

/**
 * Parse a workflow script: validate determinism, extract the `export const meta = {...}`
 * literal, and return the remaining body.
 */
export function parseWorkflowScript(script: string): ParsedWorkflow {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  }) as AnyNode;

  assertDeterministic(ast);

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new Error("`export const meta = { name, description }` must be the first statement in the script");
  }
  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new Error("meta export must be `export const meta = ...`");
  }
  if (declaration.declarations.length !== 1) throw new Error("meta export must declare only `meta`");
  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new Error("meta export must declare `meta`");
  }
  if (!declarator.init) throw new Error("meta must have a literal value");

  for (const statement of (ast.body as AnyNode[]).slice(1)) {
    if (statement.type === "ImportDeclaration" || statement.type.startsWith("Export")) {
      throw new Error("workflow scripts cannot use import or additional exports");
    }
  }

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return { meta, body: script.slice(0, first.start) + script.slice(first.end) };
}

/** Strip a surrounding markdown code fence, if the model wrapped the script in one. */
export function normalizeScript(script: string): string {
  const text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  return fence?.[1] ? fence[1].trim() : text;
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type !== "Property" || prop.computed || prop.kind !== "init" || prop.method) {
          throw new Error(`meta must be a pure literal: only plain properties allowed in ${path}`);
        }
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element || element.type === "SpreadElement") {
          throw new Error(`sparse arrays and spread not allowed in ${path}`);
        }
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (
        node.operator === "-" &&
        node.argument?.type === "Literal" &&
        typeof node.argument.value === "number"
      ) {
        return -node.argument.value;
      }
      throw new Error(`only negative number literals allowed in ${path}`);
    default:
      throw new Error(`meta must be a pure literal, found ${node.type} in ${path}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) {
    return String(node.value);
  }
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim())
    throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim()) {
    throw new Error("meta.description must be a non-empty string");
  }
  if (value.whenToUse !== undefined && typeof value.whenToUse !== "string") {
    throw new Error("meta.whenToUse must be a string");
  }
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

function assertDeterministic(node: AnyNode): void {
  if (isCallTo(node, "Date", "now") || isCallTo(node, "Math", "random") || isNewDate(node)) {
    throw new Error(NONDETERMINISM_ERROR);
  }
  for (const child of astChildren(node)) assertDeterministic(child);
}

function astChildren(node: AnyNode): AnyNode[] {
  const children: AnyNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) children.push(...value.filter(isAstNode));
    else if (isAstNode(value)) children.push(value);
  }
  return children;
}

function isAstNode(value: unknown): value is AnyNode {
  return !!value && typeof value === "object" && typeof (value as AnyNode).type === "string";
}

function isCallTo(node: AnyNode, objectName: string, propertyName: string): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee as AnyNode | undefined;
  if (callee?.type !== "MemberExpression") return false;
  const object = callee.object as AnyNode | undefined;
  if (object?.type !== "Identifier" || object.name !== objectName) return false;
  if (!callee.computed && callee.property?.type === "Identifier")
    return callee.property.name === propertyName;
  const property = callee.property as AnyNode | undefined;
  return property?.type === "Literal" && property.value === propertyName;
}

function isNewDate(node: AnyNode): boolean {
  return (
    node.type === "NewExpression" &&
    (node.callee as AnyNode | undefined)?.type === "Identifier" &&
    (node.callee as AnyNode).name === "Date"
  );
}
