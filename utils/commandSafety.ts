/**
 * Decides whether a shell command deletes files and so needs the user's
 * approval. It looks at the command word of every simple command (split on
 * `;`, `&&`, `||`, `|`, `&`, newlines, subshells and command substitution),
 * after unwrapping prefixes such as `sudo`, `env VAR=1`, `xargs` or `nohup`.
 *
 * It is a heuristic, not a parser: separators inside quotes are still treated
 * as separators, which can only cause an extra prompt, never a missed one.
 */

const DELETE_COMMANDS = new Set(['rm', 'rmdir', 'unlink', 'shred']);

// Commands that run their arguments as another command.
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'builtin',
  'exec',
  'nohup',
  'nice',
  'time',
  'timeout',
  'xargs',
  'stdbuf',
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function commandWords(segment: string): string[] {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    const base = word.split('/').pop() ?? word;
    if (ASSIGNMENT.test(word)) {
      index += 1;
    } else if (WRAPPERS.has(base)) {
      index += 1;
      // Skip the wrapper's own flags and a numeric argument (`timeout 10`).
      while (
        index < words.length &&
        (words[index].startsWith('-') || /^\d+[smhd]?$/.test(words[index]))
      ) {
        index += 1;
      }
    } else {
      break;
    }
  }
  return words.slice(index);
}

export function deletesFiles(command: string): boolean {
  const segments = command.split(/;|&&|\|\||\||&|\n|\$\(|`|\(|\)/);
  return segments.some((segment) => {
    const words = commandWords(segment);
    if (words.length === 0) return false;
    const program = words[0].split('/').pop() ?? words[0];
    if (DELETE_COMMANDS.has(program)) return true;
    if (program === 'find') {
      return words.includes('-delete') || /-exec(dir)?\s+rm\b/.test(segment);
    }
    if (program === 'git' && words[1] === 'clean') {
      return words.some(
        (word) => /^-[a-zA-Z]*f/.test(word) || word === '--force',
      );
    }
    return false;
  });
}
