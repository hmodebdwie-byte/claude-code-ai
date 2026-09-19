# Frontend: Studio on round 11

`0001-studio-on-round11.diff` is the whole Studio integration as one squashed diff
against the uploaded `frontend--opus-round11` tree (the `git format-patch` form is
not useful here: the integration is a merge commit, so walking its history also
replays the Studio branch's own baseline).

Apply with:

    git apply --binary 0001-studio-on-round11.diff

Two conflicts arose during the original merge and were both resolved in round 11's
favour, because round 11 is newer and carries explicit owner decisions:

- `src/live/services/tradeRejectionToast.js` — round 11's round-close copy kept verbatim.
- `src/components/TradingPanel.jsx` — round 11 deliberately reverses the older
  round-lock button gating; that reversal is kept.

`Matches.jsx` loses its hardcoded four-slide swipe in favour of the creator card
pager, which keeps those four built-in pages and adds one per installed indicator.
