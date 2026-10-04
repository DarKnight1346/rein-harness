# Publishing the site at rein-harness.github.io

GitHub serves `https://<name>.github.io/` from a repository called `<name>.github.io` owned by the
account or organization `<name>`. The site source stays in this repo (`site/`). A small repository in
a `rein-harness` organization builds it and hosts it.

## One-time setup

1. **Create the organization** `rein-harness` (free): https://github.com/account/organizations/new
2. **Create the repository** `rein-harness/rein-harness.github.io` (public, can be empty).
3. **Add the workflow:** copy [`pages.yml`](pages.yml) to `.github/workflows/pages.yml` in that repo.
4. **Turn on Pages:** in that repo, Settings → Pages → Source: **GitHub Actions**.
5. Run the workflow once (Actions → Deploy site → Run workflow). The site goes live at
   https://rein-harness.github.io/.
6. *(Optional: instant updates.)* Create a fine-grained token that can only access
   `rein-harness/rein-harness.github.io`, with **Contents: read & write** permission. That is the
   permission `repository_dispatch` needs. Add it to **this** repo as the Actions secret
   `SITE_DISPATCH_TOKEN`. After that, every docs change merged to `main` republishes within a minute or
   two. Without it, the site rebuilds daily and whenever you run the workflow by hand.

## Hosting somewhere else

The base URL is configurable when building:

| Where | `SITE_URL` | `BASE_PATH` |
|---|---|---|
| `rein-harness.github.io` (default) | `https://rein-harness.github.io` | `/` |
| This repo's own Pages | `https://darknight1346.github.io` | `/rein-harness` |
| Custom domain | `https://docs.example.com` | `/` |

All links between docs pages are relative, so any base path works.
