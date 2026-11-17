# Server Roles, Channels, and Permissions Specification

This document specifies the Discord role hierarchy, channel layout, permission matrix, and slash command authorization rules for `fcode-operator-bot`.

---

## 1. Role Hierarchy and Baseline Capabilities

Discord enforces role hierarchy strictly from top to bottom. The managed role `fcode-operator-bot` must be positioned immediately below `owner` in Server Settings so the bot can manage nicknames and assign every staff and stage role below it. All functional roles are referenced by Snowflake ID inside `config.yaml`.

| Rank Tier | Role Name            | Role Type          | Hoisted | Allow `ChangeNickname` | Core Capabilities and Bot Access                                                                 |
| --------- | -------------------- | ------------------ | ------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| 1         | `owner`              | Existing preserved | Yes     | Yes                    | Full administrative control and exclusive access to `/round`                                     |
| 2         | `bot`                | Existing preserved | Yes     | No                     | Shared bot role granted read and write access to log channels                                    |
| 3         | `carl-bot`           | Managed bot        | No      | Yes                    | Preserved managed bot for server audit logging                                                   |
| 4         | `fcode-operator-bot` | Managed bot        | No      | Yes                    | Executes verification, rejoin restoration, and round mutations                                   |
| 5         | `ticket-tool`        | Managed bot        | No      | No                     | Preserved managed bot for support ticket channels                                                |
| 6         | `moderator`          | Staff              | Yes     | Yes                    | Full channel access, announcement posting, member moderation, and `/student` commands            |
| 7         | `supporter`          | Staff              | Yes     | Yes                    | Access to round categories, staff channels, and ticket support                                   |
| 8         | `mentor`             | Staff              | Yes     | Yes                    | Access to round categories and staff channels                                                    |
| 9         | `round-3`            | Round              | Yes     | No                     | Unlocks `ROUND 3` (retains cumulative access to `ROUND 1` and `ROUND 2`)                         |
| 10        | `round-2`            | Round              | Yes     | No                     | Unlocks `ROUND 2` (retains cumulative access to `ROUND 1`)                                       |
| 11        | `round-1`            | Round              | Yes     | No                     | Unlocks `ROUND 1`                                                                                |
| 12        | `verified`           | Base Verified      | No      | No                     | Base role assigned immediately upon verification; hides `#✅・verification`                      |
| 13        | `@everyone`          | Default baseline   | No      | No                     | Minimal baseline (`ReadMessageHistory`, `UseApplicationCommands`); views `GATEWAY` channels only |

---

## 2. Global `@everyone` Baseline Permissions

At the guild role level, `@everyone` enables only `ReadMessageHistory` and `UseApplicationCommands`, and disables `ViewChannel`, `SendMessages`, `SendMessagesInThreads`, `CreatePublicThreads`, `CreatePrivateThreads`, `ChangeNickname`, `MentionEveryone`, `SendTTSMessages`, `SendPolls`, and `UseExternalApps`. Channel visibility and write access are granted explicitly through category and channel overwrites.

---

## 3. Categories, Channels, and Permission Overwrite Matrix

Every channel uses Unicode 6.0 emojis paired with `kebab-case` English names so characters render consistently across legacy systems and web browsers.

| Category  | Channel                                                                                | Channel Type | View Access (`ViewChannel`)                                                                              | Write or Voice Access (`SendMessages` or `Connect` and `Speak`)                                                                         |
| --------- | -------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GATEWAY` | `📖・rules`                                                                            | Text         | `owner`, `moderator`, `mentor`, `supporter`, `round-1`, `round-2`, `round-3` (hidden for `@everyone`)    | `owner`, `moderator`                                                                                                                    |
| `GATEWAY` | `📢・announcements`                                                                    | Text         | `owner`, `moderator`, `mentor`, `supporter`, `round-1`, `round-2`, `round-3` (hidden for `@everyone`)    | `owner`, `moderator`                                                                                                                    |
| `GATEWAY` | `✅・verification`                                                                     | Text         | `@everyone`, `owner`, `moderator`, `bot` (explicitly denied for `round-1..3`, `mentor`, `supporter`)     | `SendMessages` denied for candidates; `UseApplicationCommands` allowed for `@everyone`; `SendMessages` allowed for `owner`, `moderator` |
| `GATEWAY` | `🎫・support`                                                                          | Text         | `@everyone`, `owner`, `moderator`, `supporter`, `round-1..3`, `ticket-tool`, `bot` (denied for `mentor`) | `owner`, `moderator`, `ticket-tool`                                                                                                     |
| `SUPPORT` | Active and closed ticket channels (managed by Ticket Tool)                             | Text         | `owner`, `moderator`, `supporter`, `ticket-tool` (denied for `@everyone`)                                | `owner`, `moderator`, `supporter`, `ticket-tool` (plus ticket creator overwrite)                                                        |
| `ROUND 1` | `🟢・description`                                                                      | Text         | `owner`, `moderator`, `mentor`, `supporter`, `round-1`, `round-2`, `round-3`                             | `owner`, `moderator`                                                                                                                    |
| `ROUND 2` | `🟠・description`                                                                      | Text         | `owner`, `moderator`, `mentor`, `supporter`, `round-2`, `round-3`                                        | `owner`, `moderator`                                                                                                                    |
| `ROUND 3` | `🟡・description`                                                                      | Text         | `owner`, `moderator`, `mentor`, `supporter`, `round-3`                                                   | `owner`, `moderator`                                                                                                                    |
| `STAFF`   | `🔒・notification`                                                                     | Text         | `owner`, `moderator`, `mentor`, `supporter`, `bot`                                                       | `owner`, `moderator`, `mentor`, `supporter`, `bot`                                                                                      |
| `STAFF`   | `💬・staff-discussion`                                                                 | Text         | `owner`, `moderator`, `mentor`, `supporter`, `bot`                                                       | `owner`, `moderator`, `mentor`, `supporter`, `bot`                                                                                      |
| `STAFF`   | `📝・bot-commands`                                                                     | Text         | `owner`, `moderator`, `mentor`, `supporter`, `bot`                                                       | `owner`, `moderator`, `bot`                                                                                                             |
| `STAFF`   | `🔊・staff-meeting`                                                                    | Voice        | `owner`, `moderator`, `mentor`, `supporter`                                                              | `Connect` and `Speak` allowed for all listed viewers                                                                                    |
| `EVENT`   | `movement-log`, `member-log`, `message-log`, `server-log`, `ticket-log`, and `warning` | Text         | `owner`, `moderator`, `bot`, `carl-bot`, `ticket-tool`                                                   | `bot`, `carl-bot`, `ticket-tool` (read-only for `owner`, `moderator`)                                                                   |

---

## 4. Slash Command Authorization Matrix

All slash commands (`/verify`, `/student`, `/round`, `/system`) reply publicly in the invoking channel so staff and candidates can observe command outcomes directly. Only the persistent `Verify Account` button in `#✅・verification` uses ephemeral responses to keep the verification channel clean.

| Command                 | Subcommand | Authorized Caller                              | Purpose                                                                                                |
| ----------------------- | ---------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `/verify`               | Default    | Every guild member                             | Verifies new candidates in one step or restores returning verified members with public channel replies |
| `Verify Account` button | Component  | Every guild member                             | Triggers the same one-step verification or restoration flow with ephemeral replies                     |
| `/student`              | `lookup`   | Server Owner, `ownerRoleId`, `moderatorRoleId` | Inspects stored student identity, full name, and round flags by `@user` or Student ID                  |
| `/student`              | `register` | Server Owner, `ownerRoleId`, `moderatorRoleId` | Manually registers a student (opens a Modal when `full-name` and `student-id` are omitted)             |
| `/student`              | `reset`    | Server Owner, `ownerRoleId`, `moderatorRoleId` | Deletes a student record and strips recruitment roles by `@user` or Student ID                         |
| `/round`                | `promote`  | Server Owner and `ownerRoleId` only            | Transitions candidates between any two stages (`verified`, `round-1..3`) after confirmation prompt     |
| `/round`                | `revoke`   | Server Owner and `ownerRoleId` only            | Bulk removes a round role with `exclude` or `only` filters after confirmation prompt                   |
| `/system`               | `verify`   | Server Owner and `ownerRoleId` only            | Toggles the verification gate (`enabled`) and optionally posts/updates the verification button panel   |
| `/system`               | `sync`     | Server Owner and `ownerRoleId` only            | Synchronizes SQLite student records (nicknames and roles) to Discord                                   |
| `/system`               | `reload`   | Server Owner and `ownerRoleId` only            | Validates and hot-reloads `config.yaml`, `Logger`, and background timers with zero downtime            |
