import type { Position, TextEditor } from "vscode"
import type { SyntaxNode } from "web-tree-sitter"

import { logger } from "../../common/logger"
import { getParser } from "../completion/parser"

/** Inclusive, zero-based lines, suitable for the existing whole-line diff. */
export type EditTarget = [start: number, end: number]

const FUNCTIONS = new Set([
  "function_declaration", "function_expression", "generator_function_declaration",
  "generator_function", "arrow_function", "method_definition", "function_definition",
  "function_item", "method_declaration", "constructor_declaration"
])
const BLOCKS = new Set([
  "if_statement", "for_statement", "for_in_statement", "for_each_statement",
  "while_statement", "do_statement", "switch_statement", "try_statement",
  "with_statement", "match_statement", "statement_block", "block"
])

/** Keep the declaration around an expression, rather than returning a bare arrow. */
const declarationOf = (node: SyntaxNode): SyntaxNode => {
  let target = node
  if (target.parent?.type === "variable_declarator") {
    const declaration = target.parent.parent
    // Widening a single declarator must not rewrite neighbouring variables.
    if (declaration && declaration.namedChildren.filter((child) => child.type === "variable_declarator").length === 1) {
      target = declaration
    }
  } else if (target.parent?.type === "assignment_expression" && target.parent.parent?.type === "expression_statement") {
    target = target.parent.parent
  }
  if (target.parent?.type === "export_statement" || target.parent?.type === "decorated_definition") {
    target = target.parent
  }
  return target
}

/**
 * Functions take precedence over their inner blocks. Outside a function,
 * prefer a complete control statement to just its body (including else/catch).
 * Use both cursor coordinates; same-line declarations must stay distinct.
 */
export const findEditTarget = (
  root: SyntaxNode,
  position: Pick<Position, "line" | "character">,
  text: string
): EditTarget | undefined => {
  const point = { row: position.line, column: position.character }
  let node: SyntaxNode | null = root.namedDescendantForPosition(point)
  let block: SyntaxNode | undefined
  let target: SyntaxNode | undefined
  while (node && node !== root) {
    if (FUNCTIONS.has(node.type) && node.childForFieldName("body")) {
      target = declarationOf(node)
      break
    }
    if (BLOCKS.has(node.type)) {
      // Replace an anonymous block with the first complete control statement.
      if (!block || block.type === "statement_block" || block.type === "block") block = node
    }
    node = node.parent
  }
  target ??= block
  if (!target || target.hasError || target.isMissing) return undefined

  // Include an immediately preceding documentation comment with its declaration.
  const comment = target.previousNamedSibling
  const start = comment?.type === "comment" && comment.text.startsWith("/**") &&
    !text.slice(comment.endIndex, target.startIndex).trim()
    ? comment.startPosition : target.startPosition
  const end = target.endPosition
  const lines = text.split("\n")
  const last = end.column === 0 && end.row > start.row ? end.row - 1 : end.row
  // Whole-line edits cannot safely isolate a method sharing a line with its class,
  // a callback inside a call, or two unrelated declarations on the same line.
  if (lines[start.row]?.slice(0, start.column).trim()) return undefined
  if (end.row === last && !/^[\s;]*$/.test(lines[last]?.slice(end.column) ?? "")) return undefined
  return [start.row, last]
}

/** Unsupported languages and broken targets leave the command's old fallback intact. */
export const getEditTarget = async (
  editor: TextEditor
): Promise<EditTarget | undefined> => {
  const { document, selection } = editor
  try {
    const parser = await getParser(document.uri.fsPath)
    if (!parser) return undefined
    const text = document.getText()
    const tree = parser.parse(text)
    if (!tree) return undefined
    try {
      return findEditTarget(tree.rootNode, selection.active, text)
    } finally {
      tree.delete()
    }
  } catch (error) {
    logger.warn(`Could not resolve the inline edit target: ${error}`)
    return undefined
  }
}
