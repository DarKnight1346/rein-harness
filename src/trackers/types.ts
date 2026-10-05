/**
 * Issue trackers that can hand work to Rein: an issue assigned to you and carrying a label (by
 * default `rein`) starts a session on its own branch; the result is posted back as a comment.
 */
export type TrackerKind = 'github' | 'linear' | 'gitlab' | 'azure' | 'jira';

/** One configured tracker (non-secret settings; tokens live in the vault). */
export type TrackerConfig = {
  kind: TrackerKind;
  /** github: "owner/repo" · gitlab: project path or id · azure: "org/project" · jira: project key · linear: team key (optional). */
  project?: string;
  /** gitlab: base URL (default https://gitlab.com) · jira: https://you.atlassian.net · azure: https://dev.azure.com */
  url?: string;
  /** jira: the account email the API token belongs to. */
  email?: string;
  /** The label/tag that hands an issue to Rein (default "rein"). */
  label?: string;
  /** Model for the session (default: the subagent model). */
  model?: string;
};

export type Issue = {
  /** Stable across polls: "<kind>:<id>". */
  key: string;
  /** What people call it: "#42", "ENG-12", "!7"… */
  ref: string;
  title: string;
  body: string;
  url: string;
  /** Opaque, for commenting back. */
  handle: unknown;
};

export interface Tracker {
  readonly kind: TrackerKind;
  readonly label: string;
  /** Open issues assigned to the user that carry the label. */
  list(): Promise<Issue[]>;
  comment(issue: Issue, markdown: string): Promise<void>;
}
