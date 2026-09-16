const TASK_MARKER = /^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\])/

export function setTaskCheckedAtLine(markdown: string, lineNumber: number, checked: boolean): string | null {
  const lines = markdown.split('\n')
  const line = lines[lineNumber]
  if (line === undefined || !TASK_MARKER.test(line)) return null

  lines[lineNumber] = line.replace(TASK_MARKER, `$1${checked ? 'x' : ' '}$3`)
  return lines.join('\n')
}
