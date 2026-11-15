# Server Roles, Channels, and Permissions Specification

This document specifies the Discord role hierarchy, channel layout, permission matrix, and slash command authorization rules for `fcode-operator-bot`.

---

## 1. Role Hierarchy and Baseline Capabilities

Discord enforces role hierarchy strictly from top to bottom. The managed role `fcode-operator-bot` must be positioned immediately below `owner` in Server Settings so the bot can manage nicknames and assign every staff and stage role below it. All functional roles are referenced by Snowflake ID inside `config.yaml`.

| Rank Tier | Role Name            | Role Type          | Hoisted | Allow `ChangeNickname` | Core Capabilities and Bot Access                                                                 |
| --------- | -------------------- | ------------------ | ------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| 1         | `owner`              | Existing preserved | Yes     | Yes                    | Full administrative control and exclusive access to `/challenge`                                 |
| 2         | `bot`                | Existing preserved | Yes     | No                     | Shared bot role granted read and write access to log channels                                    |
| 3         | `carl-bot`           | Managed bot        | No      | Yes                    | Preserved managed bot for server audit logging                                                   |
| 4         | `fcode-operator-bot` | Managed bot        | No      | Yes                    | Executes verification, rejoin restoration, and stage mutations                                   |
| 5         | `ticket-tool`        | Managed bot        | No      | No                     | Preserved managed bot for support ticket channels                                                |
| 6         | `moderator`          | Staff              | Yes     | Yes                    | Full channel access, announcement posting, member moderation, and `/student` commands            |
| 7         | `supporter`          | Staff              | Yes     | Yes                    | Access to challenge categories, staff channels, and ticket support                               |
| 8         | `mentor`             | Staff              | Yes     | Yes                    | Access to challenge categories and staff channels                                                |
| 9         | `challenge-3`        | Stage              | Yes     | No                     | Unlocks `CHALLENGE 3` (retains cumulative access to `CHALLENGE 1` and `CHALLENGE 2`)             |
| 10        | `challenge-2`        | Stage              | Yes     | No                     | Unlocks `CHALLENGE 2` (retains cumulative access to `CHALLENGE 1`)                               |
| 11        | `challenge-1`        | Stage              | Yes     | No                     | Unlocks `CHALLENGE 1` and hides `#✅・verification`                                              |
| 12        | `@everyone`          | Default baseline   | No      | No                     | Minimal baseline (`ReadMessageHistory`, `UseApplicationCommands`); views `GATEWAY` channels only |

---

## 2. Global `@everyone` Baseline Permissions

At the guild role level, `@everyone` enables only `ReadMessageHistory` and `UseApplicationCommands`, and disables `ViewChannel`, `SendMessages`, `SendMessagesInThreads`, `CreatePublicThreads`, `CreatePrivateThreads`, `ChangeNickname`, `MentionEveryone`, `SendTTSMessages`, `SendPolls`, and `UseExternalApps`. Channel visibility and write access are granted explicitly through category and channel overwrites.

---

## 3. Categories, Channels, and Permission Overwrite Matrix

Every channel uses Unicode 6.0 emojis paired with `kebab-case` English names so characters render consistently across legacy systems and web browsers.

| Category      | Channel                                                                                | Channel Type | View Access (`ViewChannel`)                                                                                  | Write or Voice Access (`SendMessages` or `Connect` and `Speak`)                                                                         |
| ------------- | -------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GATEWAY`     | `📖・rules`                                                                            | Text         | `@everyone`, staff, `challenge-1`, `challenge-2`, `challenge-3`                                              | `owner`, `moderator`                                                                                                                    |
| `GATEWAY`     | `📢・announcements`                                                                    | Text         | `@everyone`, staff, `challenge-1`, `challenge-2`, `challenge-3`                                              | `owner`, `moderator`                                                                                                                    |
| `GATEWAY`     | `✅・verification`                                                                     | Text         | `@everyone`, `owner`, `moderator`, `bot` (explicitly denied for `challenge-1..3`, `mentor`, `supporter`)     | `SendMessages` denied for candidates; `UseApplicationCommands` allowed for `@everyone`; `SendMessages` allowed for `owner`, `moderator` |
| `GATEWAY`     | `🎫・support`                                                                          | Text         | `@everyone`, `owner`, `moderator`, `supporter`, `challenge-1..3`, `ticket-tool`, `bot` (denied for `mentor`) | `owner`, `moderator`, `ticket-tool`                                                                                                     |
| `SUPPORT`     | Active and closed ticket channels (managed by Ticket Tool)                             | Text         | `owner`, `moderator`, `supporter`, `ticket-tool` (denied for `@everyone`)                                    | `owner`, `moderator`, `supporter`, `ticket-tool` (plus ticket creator overwrite)                                                        |
| `CHALLENGE 1` | `🟢・description`                                                                      | Text         | `owner`, `moderator`, `mentor`, `supporter`, `challenge-1`, `challenge-2`, `challenge-3`                     | `owner`, `moderator`                                                                                                                    |
| `CHALLENGE 2` | `🟠・description`                                                                      | Text         | `owner`, `moderator`, `mentor`, `supporter`, `challenge-2`, `challenge-3`                                    | `owner`, `moderator`                                                                                                                    |
| `CHALLENGE 3` | `🟡・description`                                                                      | Text         | `owner`, `moderator`, `mentor`, `supporter`, `challenge-3`                                                   | `owner`, `moderator`                                                                                                                    |
| `STAFF`       | `🔒・notification`                                                                     | Text         | `owner`, `moderator`, `mentor`, `supporter`, `bot`                                                           | `owner`, `moderator`, `mentor`, `supporter`, `bot`                                                                                      |
| `STAFF`       | `💬・staff-discussion`                                                                 | Text         | `owner`, `moderator`, `mentor`, `supporter`, `bot`                                                           | `owner`, `moderator`, `mentor`, `supporter`, `bot`                                                                                      |
| `STAFF`       | `📝・bot-commands`                                                                     | Text         | `owner`, `moderator`, `mentor`, `supporter`, `bot`                                                           | `owner`, `moderator`, `bot`                                                                                                             |
| `STAFF`       | `🔊・staff-meeting`                                                                    | Voice        | `owner`, `moderator`, `mentor`, `supporter`                                                                  | `Connect` and `Speak` allowed for all listed viewers                                                                                    |
| `EVENT`       | `movement-log`, `member-log`, `message-log`, `server-log`, `ticket-log`, and `warning` | Text         | `owner`, `moderator`, `bot`, `carl-bot`, `ticket-tool`                                                       | `bot`, `carl-bot`, `ticket-tool` (read-only for `owner`, `moderator`)                                                                   |

---

## 4. Slash Command Authorization Matrix

All slash commands (`/verify`, `/student`, `/challenge`) reply publicly in the invoking channel so staff and candidates can observe command outcomes directly. Only the persistent `Verify Account` button in `#✅・verification` uses ephemeral responses to keep the verification channel clean.

| Command                 | Subcommand     | Authorized Caller                              | Purpose                                                                                                |
| ----------------------- | -------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `/verify`               | Default        | Every guild member                             | Verifies new candidates in one step or restores returning verified members with public channel replies |
| `Verify Account` button | Component      | Every guild member                             | Triggers the same one-step verification or restoration flow with ephemeral replies                     |
| `/student`              | `lookup`       | Server Owner, `ownerRoleId`, `moderatorRoleId` | Inspects stored student identity, full name, and stage flags                                           |
| `/student`              | `register`     | Server Owner, `ownerRoleId`, `moderatorRoleId` | Manually registers or updates a student nickname and record for support resolution                     |
| `/student`              | `reset`        | Server Owner, `ownerRoleId`, `moderatorRoleId` | Deletes a student record and strips recruitment roles for re-verification                              |
| `/student`              | `sync`         | Server Owner, `ownerRoleId`, `moderatorRoleId` | Synchronizes SQLite student records (nicknames and stage roles) to Discord                             |
| `/challenge`            | `advance`      | Server Owner and `ownerRoleId` only            | Promotes all candidates from source stage to target stage with `exclude` or `only` filters             |
| `/challenge`            | `revoke`       | Server Owner and `ownerRoleId` only            | Bulk removes a stage role from selected members and updates SQLite                                     |
| `/challenge`            | `verify`       | Server Owner and `ownerRoleId` only            | Toggles the server verification gate (`enabled` boolean) in SQLite                                     |
| `/challenge`            | `verify-panel` | Server Owner and `ownerRoleId` only            | Posts or updates the persistent `Verify Account` panel message in a selected text channel              |
