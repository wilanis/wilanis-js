/**
 * Where a node runs, as a link to where the run it is nested in runs. A call nested n deep adds one link instead of
 * copying a path of n ids, so a graph that calls itself costs the same at every depth (#1032). The path is spelled
 * out only when something reads it: a stub's key, a rehearsal's node path.
 */
export class NodePlace {
  private constructor(
    private readonly parent: NodePlace | undefined,
    private readonly ids: readonly string[],
  ) {}

  /** The place a path names from the outermost run, or none for the outermost run itself. */
  static of(path: readonly string[] | undefined): NodePlace | undefined {
    return path?.length ? new NodePlace(undefined, path) : undefined;
  }

  /** The place `ids` lead to from `parent`, or from the outermost run when there is no parent. */
  static below(parent: NodePlace | undefined, ids: readonly string[]): NodePlace {
    return new NodePlace(parent, ids);
  }

  /** The ids from the outermost run down to this place. */
  path(): string[] {
    const links: (readonly string[])[] = [];
    for (let at: NodePlace | undefined = this; at; at = at.parent) links.push(at.ids);
    return links.reverse().flat();
  }
}
