# Brooklyn parking ticket map

A free public map of where, when and on which rounds parking tickets get written in Brooklyn, built from NYC Open Data.

- **No AI or paid services.** Searches run in the visitor's browser on pre-built files.
- **Updates itself** every morning with GitHub Actions.
- **Public data only.** Plates, vehicle details and ticket numbers are never downloaded or published. Each agent's real code is replaced with a random ID that resets every month, and the newest 21 days are held back.

## One-time setup (about 30 minutes, no coding)

1. **Create a GitHub account** at github.com (free).
2. **Create a repository.** Click **+** (top right) → **New repository**. Name it `brooklyn-ticket-map`, choose **Public**, and click **Create repository**.
3. **Upload the files.** On the new repo page, click **uploading an existing file**. Unzip the download, open the folder, select everything inside it and drag it onto the page. Click **Commit changes**.
   - On a Mac, the `.github` folder is hidden. In Finder press **Cmd + Shift + .** to show it before dragging.
   - Check that the repo now shows `.github`, `cache`, `pipeline`, `site`, `config.json`. If `.github` is missing, see "Add the workflow by hand" below.
4. **Add the secret that scrambles agent IDs.** **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
   - Name: `AGENT_ID_SALT`
   - Secret: a long random sentence only you know (at least 16 characters). Don't share it or reuse it anywhere.
5. **Turn on the website.** **Settings** → **Pages** → under **Source**, choose **GitHub Actions**.
6. **Run it the first time.** **Actions** tab → click **I understand my workflows, go ahead and enable them** if asked → **Update map** → **Run workflow**.
   - The first run can take up to 3–4 hours because it locates every address once. Later runs are much faster.
   - When it finishes with a green check, your map is live at `https://YOUR-USERNAME.github.io/brooklyn-ticket-map/`.

The map fills in over the first few days: each run locates up to 40,000 new addresses, busiest first.

## Optional: faster downloads

NYC Open Data throttles anonymous downloads. A free app token speeds things up:
sign up at data.cityofnewyork.us → your profile → **Developer settings** → **Create new app token**, then add it as a repository secret named `SOCRATA_APP_TOKEN`.

## Settings you can change

Edit `config.json` on GitHub (click it, then the pencil icon):

| Setting | What it does |
|---|---|
| `window_days` | How many days of tickets the heat map covers (default 180) |
| `route_days` | How many days of agent rounds to keep (default 60) |
| `delay_days` | How many recent days to hold back (default 21) |
| `min_agent_tickets` | Hide agents with fewer tickets than this in the period |
| `borough_name`, `county_codes`, `bbox`, `center` | Change these to switch boroughs |

## Troubleshooting

- **The page says the data hasn't been built yet.** The workflow hasn't finished a run. Check the **Actions** tab.
- **A run failed with "AGENT_ID_SALT is missing".** Redo step 4. The pipeline refuses to run without it so real agent codes can't leak.
- **GitHub emailed that the scheduled workflow was disabled.** Open **Actions** → **Update map** → **Enable workflow**.
- **"No datasets found".** Find the newest "Parking Violations Issued - Fiscal Year" dataset on NYC Open Data, copy the 9-character id from its URL (like `abcd-1234`), and put it in `config.json` → `dataset_ids`.

### Add the workflow by hand

**Actions** tab → **set up a workflow yourself**. Name the file `update.yml`, paste in the contents of `.github/workflows/update.yml` from the download, and click **Commit changes**.

## How it works

`pipeline/build.py` downloads Brooklyn tickets written by agents (camera tickets are excluded), drops personal fields, replaces agent codes, locates addresses with the city's free NYC GeoSearch service, and writes small JSON files to `site/data/`. The workflow then publishes the `site/` folder to GitHub Pages.

Note: ticket locations come from the address on the ticket. Tickets written at an intersection without a house number aren't on the map yet.
