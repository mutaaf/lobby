# Parked: needs the owner (money, accounts or credentials)

One line each, with the exact step. The agent appends; the owner removes a line once it's done.

- **Google Play uploads (17-0, Hearth).** The developer account exists, but "Create app" is greyed out
  until Play's account verification finishes (18-0/docs/android-release.md).
  - Once the app records exist: Play Console → Setup → API access → create a service account with "Release
    manager" on both apps.
  - Save its JSON key as `~/.config/lobby/play-service-account.json`.
  - Lobby then uploads phone, tablet, feature graphic and icon on its next run.
- **Amazon Appstore / Galaxy Store.** Both need a (free) developer account the owner creates. Assets are
  ready in `store/lobby/out/{amazon,galaxy}`.
- **Alexa.** No app has a skill yet. When one does, the skill's `skill.json` is discovered and the icons and
  card render automatically. Publishing needs an Amazon developer account.
