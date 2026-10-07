import { githubTracker } from './github.js';
import { azureTracker, gitlabTracker, jiraTracker, linearTracker } from './rest.js';
/**
 * A tracker from its settings; tokens come from the vault (the agent never sees them):
 * LINEAR_API_KEY, GITLAB_TOKEN, AZURE_DEVOPS_PAT, JIRA_API_TOKEN. GitHub uses your `gh` login.
 */
export function makeTracker(cfg, secrets) {
    switch (cfg.kind) {
        case 'github':
            return githubTracker(cfg);
        case 'linear':
            return linearTracker(cfg, secrets);
        case 'gitlab':
            return gitlabTracker(cfg, secrets);
        case 'azure':
            return azureTracker(cfg, secrets);
        case 'jira':
            return jiraTracker(cfg, secrets);
        default:
            throw new Error(`unknown tracker kind "${cfg.kind}" (github, linear, gitlab, azure, jira)`);
    }
}
