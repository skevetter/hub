const WORD = /(?:'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\\[\s\S]|[^\s"'\\;&|>])+/uy;
const SEPARATOR = /[\s;&|>]+/uy;
const COMPOUND = /[;|>`]|&&|\$\(/u;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z_0-9]*=/u;
const CLIENT_COMMANDS = "install ci run test build lint exec";
const SUBCOMMANDS = new Map([
  [
    "git",
    "status diff log show add commit push pull fetch checkout switch branch merge rebase clone",
  ],
  ["npm", CLIENT_COMMANDS],
  ["pnpm", CLIENT_COMMANDS],
  ["yarn", CLIENT_COMMANDS],
  ["go", "build test run vet mod"],
  ["cargo", "build test run check clippy fmt"],
]);
const PROGRAMS = new Set("make rg grep cat find sed jq ls node pytest tsc".split(" "));
const WRAPPERS = new Map([
  ["bash", ["-c", "-lc"]],
  ["sh", ["-c"]],
  ["zsh", ["-c", "-lc"]],
]);

function shellWord(value: string): string {
  return value.replace(
    /'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])/gu,
    (_match, single: string | undefined, double: string | undefined, escaped: string | undefined) =>
      single ?? escaped ?? double?.replace(/\\([$`"\\\n])/gu, "$1") ?? "",
  );
}

function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let index = 0;
  while (index < command.length) {
    SEPARATOR.lastIndex = index;
    if (SEPARATOR.test(command)) {
      index = SEPARATOR.lastIndex;
      continue;
    }
    WORD.lastIndex = index;
    const match = WORD.exec(command);
    if (!match) return undefined;
    words.push(shellWord(match[0]));
    index = WORD.lastIndex;
  }
  const first = words.findIndex((word) => !ASSIGNMENT.test(word));
  return first === -1 ? [] : words.slice(first);
}

function basename(word: string) {
  return word.slice(word.lastIndexOf("/") + 1);
}

function shapeCommand(words: string[], compound: boolean): string {
  const [word = "", subcommand] = words;
  const program = basename(word);
  const commands = SUBCOMMANDS.get(program);
  if (!commands) return PROGRAMS.has(program) ? program : "command";
  if (!compound && subcommand && commands.split(" ").includes(subcommand))
    return `${program} ${subcommand}`;
  return program;
}

export function shapeShell(command: string, normalize: (value: string) => string): string {
  const words = shellWords(command);
  if (!words) return "command";
  return renderWords(words.map(normalize), COMPOUND.test(normalize(command)), normalize);
}

function renderWords(words: string[], compound: boolean, normalize: (value: string) => string) {
  const [program = "", flag = "", script] = words;
  if (script !== undefined && WRAPPERS.get(basename(program))?.includes(flag)) {
    const inner = shellWords(script)?.map(normalize);
    return inner ? shapeCommand(inner, compound || COMPOUND.test(script)) : "command";
  }
  return shapeCommand(words, compound);
}
