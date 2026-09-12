# L2 Discount Map

An interactive map of L2 splitters with an active fiber discount — pin
color/label read live from the discount lookup table, filterable by
archetype/district/port group, synced to a Google Sheet.

Anyone signed in with an allow-listed Google account sees the same full
discount dataset — the page itself ships with no discount data at all; it's
fetched after sign-in.

On top of that, field reps ("subordinates") can write a free-text note about
an L2 they've visited in person, tagged to the L2/village with their GPS
location captured at submission time. A second role ("leader") can review
every submitted note — across all subordinates, not scoped to a sub-team —
in a lightweight Feedback dashboard (stat tiles, filters, a list, and the
note locations plotted on the map). See "Roles and feedback" below.

## How it fits together

```
Browser (this page, hosted on GitHub Pages)
   │  Google Sign-In (Google Identity Services)
   ▼
Apps Script Web App  ──executes as the Sheet owner──▶  Google Sheet
   │   verifies the ID token against Google directly        "Users" tab (who's allowed in + their role)
   │   checks the signed-in email is in the "Users" tab      "L2 Points" tab
   │   returns the full L2 Points + Condition tables         "Condition" tab
   ▼                                                         "Feedback" tab (field notes, append-only)
this page renders the map/list/detail panel from that data
```

`update_l2_sheet.py` is a separate, local-only tool — it re-reads the source
xlsx file (plus a village-name lookup file) on your machine and pushes the
current data into the Sheet. It's never called from the hosted page.

District boundaries (the dashed อำเภอ outlines) are the one thing that stays
embedded directly in `index.html` rather than coming from the Sheet — they're
public government administrative data (UN OCHA / Royal Thai Survey Dept),
not internal discount-targeting data, so there's nothing sensitive about
shipping them in a public repo.

## One-time setup

### 1. Google Cloud Console — OAuth Client ID

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and
   create a new project (or pick an existing one) dedicated to this app —
   keep it separate from any other project's OAuth client, including the
   Route Planner project's, so the two stay independent.
2. **APIs & Services → OAuth consent screen** — configure it (External or
   Internal depending on your Google Workspace situation), add yourself as a
   test user if it stays in "Testing" publish status.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application**
   - Authorized JavaScript origins — add both:
     - `https://<your-github-username>.github.io`
     - `http://localhost:8092` (for local testing via
       `Start L2 Discount Map.command`)
   - Leave "Authorized redirect URIs" empty — Google Identity Services'
     sign-in button doesn't use a redirect flow.
4. Copy the **Client ID** (looks like `123...-abc....apps.googleusercontent.com`).
   You do **not** need the client secret for this — the page only ever uses
   the Client ID, client-side.

### 2. Google Sheet + Apps Script backend

1. Create a new Google Sheet, dedicated to this app (don't reuse Route
   Planner's Sheet — this project's Apps Script deployment and secret are
   its own, independent set).
2. **Extensions → Apps Script**, delete the starter code, paste in the full
   contents of `Sheets Sync - Apps Script Code.gs` from this repo.
3. **Project Settings** (gear icon, left sidebar) → **Script Properties** →
   add two:
   - `OAUTH_CLIENT_ID` = the Client ID from step 1.
   - `SYNC_SECRET` = any random string, e.g. from `openssl rand -hex 24` in a
     terminal. Gates the `syncL2Data` action (used only by
     `update_l2_sheet.py`, see step 5) — without it, anyone who finds the
     deployment URL could overwrite the entire dataset with one request,
     since that action can't go through the sign-in check the way `myL2Data`
     does.
4. **Deploy → New deployment**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
     (real access control happens via the ID token + Users tab check inside
     the script, not via this deployment setting)
5. Deploy, authorize when prompted, copy the **Web app URL**.

### 3. Wire the two together

1. In `index.html`, set `GOOGLE_CLIENT_ID` (near the bottom of the
   `<script>` block) to the Client ID from step 1.
2. Set `DEFAULT_SYNC_URL` to the Web app URL from step 2.
3. In `update_l2_sheet.py`, set `SYNC_URL` to that same Web app URL.

### 4. Add your team to the Users tab

1. Open the page and sign in once — this auto-creates a "Users" tab in the
   Sheet with a sample row (and, until you've done this, `myL2Data` correctly
   returns "not set up yet" for everyone, including you).
2. In the Sheet, edit that row (or add a new one) for yourself: `email |
   note | role` — the `note` column is just for your own reference, it isn't
   read by the script. Set `role` to `leader` or `subordinate`; leave it
   blank (or omit it entirely on older rows) and the script treats that row
   as `subordinate`. Add a row per teammate. Delete the sample row.
   - **subordinate**: can write field feedback on any L2 (see "Roles and
     feedback" below), same as everyone else already could do with the map
     itself.
   - **leader**: everything a subordinate can do, plus read access to the
     Feedback dashboard — every note from every subordinate, not just their
     own team.

### 5. Push the data

Create a file named `l2_sync_secret.txt` outside this repo, in the
`Dashboard` folder's `Config/` directory — containing exactly the
`SYNC_SECRET` value from step 2, no extra whitespace (this is a separate
file from Route Planner's `sync_secret.txt` — the two projects' secrets are
independent). **Never commit this file**; it lives outside the repo
specifically so it can't be.

Then run:

```
python3 update_l2_sheet.py
```

(or double-click `Update L2 Discount Map.command` in the Dashboard folder's
`Launchers/`, once that's set up) to populate the "L2 Points" / "Condition"
tabs. Re-run it any time the source Project Atlas xlsx changes.

### 6. Deploy to GitHub Pages

Push this repo to GitHub, then **Settings → Pages → Source: Deploy from a
branch → `main` / `(root)`**. The page will be live at
`https://<your-username>.github.io/<repo-name>/`.

## Roles and feedback

No setup step creates the "Feedback" tab directly — same as "Users", it's
created automatically the first time anyone submits a note (via the
"Add feedback" box at the bottom of an L2's detail panel, which every
allow-listed user sees, leader or subordinate). Each row records who wrote
the note, which L2/village it's tagged to, the note text, and the GPS
location + accuracy captured at the moment of submission — alongside that
L2's own recorded lat/lon, so the Feedback dashboard can show the distance
between "where the L2 actually is" and "where this note was written from."

Leaders get a "Feedback" entry (topbar button on desktop, a third tab on
mobile) that isn't shown to subordinates at all. It opens a dashboard with
summary stat tiles, filters (village / submitter / date range), a list of
every note across every subordinate (flat — not scoped to any team), and
those notes' locations plotted on the map as distinct purple pins. It's
fetched lazily, the first time a leader actually opens it, not at sign-in.

## Local testing

`Start L2 Discount Map.command` (in the Dashboard folder's `Launchers/`)
serves this page over `http://localhost:8092` instead of `file://` — Google
Sign-In only works from an origin that's on the OAuth client's allow-list,
and `file://` isn't one you can add.

## Security notes

- The Apps Script deployment uses "Anyone" access, but that's not the real
  gate — every `myL2Data` request carries a Google ID token, which the
  script verifies directly against Google (checking both the signature and
  that it was issued for *this* app's Client ID) before trusting the email
  in it, then checks that email is a row in the Users tab.
- The L2 points/discount dataset itself has no per-person scoping — every
  allow-listed viewer gets the same full dataset there. Feedback is the one
  place that does get scoped: `getFeedback` checks the signed-in user's
  `role` in the Users tab and refuses (`forbidden`) anyone who isn't a
  `leader`, even if they call the action directly rather than through the
  page's UI. `submitFeedback` itself is *not* role-gated — any allow-listed
  user, leader or subordinate, can write a note.
- `syncL2Data` can't go through the sign-in check at all — it's not a person
  signing in, it's `update_l2_sheet.py` running on your own machine — so
  it's gated by `SYNC_SECRET` instead (see step 2 and step 5 above). This
  deployment's URL is not actually secret; it's embedded directly in the
  public `index.html`, so without this, "Anyone" access would mean anyone on
  the internet could overwrite the dataset with one request.
