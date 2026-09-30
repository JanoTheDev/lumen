import { classifyQuery } from './query-classifier'

const SPLIT_RE = /\s+(?:and\s+also|also\s+|and\s+then|and\s+|,\s*then\s+|,\s*and\s+|,\s+|;\s*|then\s+)/i

export function splitSubtasks(prompt: string): string[] {
  const parts = prompt
    .split(SPLIT_RE)
    .map(p => p.trim().replace(/^(and|also|then)\s+/i, '').replace(/^[,;.\s]+|[,;\s]+$/g, '').trim())
    .filter(Boolean)
  if (parts.length <= 1) return [prompt]
  return parts
}

// Only parallelize when every subtask is a pure read-only answer query. Action/locate/guide
// subtasks affect screen state and MUST stay sequential.
export function canParallelize(subtasks: string[]): boolean {
  if (subtasks.length < 2) return false
  return subtasks.every(s => {
    const intent = classifyQuery(s)
    return intent.mode === 'answer' && !intent.isContinuation
  })
}

export function mergeAnswers(subtasks: string[], answers: string[]): string {
  if (subtasks.length !== answers.length) {
    return answers.join('\n\n')
  }
  return subtasks.map((task, i) => `**${task}**\n${answers[i]}`).join('\n\n')
}
