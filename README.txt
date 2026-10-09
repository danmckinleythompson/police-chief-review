Police-chief proposal review

Public website files: index.html, styles.css, app.js, and this README only.
Never copy case JSON, answer JSON, databases, or project data into this folder
or into a public website repository.

Open the website in a current browser, then choose Open case file and select
the private JSON bundle on your computer. The app remembers that bundle and
answers in this browser's IndexedDB storage. Imported files are not uploaded.
No third-party scripts, fonts, analytics, service workers, or remote data
requests are used. Source links open only when clicked, with no referrer.

Each case presents the directory assertion, new evidence, and a proposed
decision. Choose Agree, Dispute, or Skip for now. A note is optional. Disputes
can also suggest a name or year. Directory edition years are not proven
service years. This is nonblinded development feedback, not an independent
accuracy audit. Feedback never promotes a correction into canonical data.

Wait for Saved before closing the tab. Export answers regularly and keep
the downloaded JSON with your private case file. Clearing browser/site data,
using private browsing, or changing browsers can lose browser-local work.
Restore answers imports a matching backup without overwriting differing
saved answers. It restores the latest answer as a new revision; the original
backup retains its complete history. An unsaved-draft export is a recovery
artifact for manual reconciliation, not a normal answer backup.

Answers are keyed to the bundle ID and a SHA-256 fingerprint of the complete
case. Changing any case contents starts a fresh review; earlier revisions
remain in browser storage. Reopen the old packet to access/export old reviews.
Two tabs cannot silently overwrite one another: a stale save is blocked.

The same source files also work with the standard-library local server:
  python3 code/tenure_validation/run_chief_tenure_proposal_review_app.py --open-browser
Default URL: http://127.0.0.1:8767/
The server reads modified_data/chief_tenure_proposal_review_bundle.json and
stores append-only revisions in modified_data/chief_tenure_proposal_reviews/
proposal_reviews.sqlite3. Export answers is a portable backup for this mode
too. No source data is rewritten. Avoid running separate copies of a synced
SQLite database simultaneously on different machines.

Synthetic validation (no project evidence or benchmark data is opened):
  python3 code/tenure_validation/check_chief_tenure_proposal_review_app.py

For GitHub Pages, deploy only the four public website files above. The static
page's Content Security Policy blocks all connections; the local server
explicitly enables same-origin connections only in the HTML it serves.
