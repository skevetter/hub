export class ProjectCommandError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProjectCommandError";
  }
}
