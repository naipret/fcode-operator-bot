# Server Roles, Channels, and Permissions Specification

This document specifies the Discord role hierarchy, channel layout, permission matrix, and slash command authorization rules for `fcode-operator-bot`.

---

## 1. Role Hierarchy and Baseline Capabilities

Discord enforces role hierarchy strictly from top to bottom. The managed role `fcode-operator-bot` must be positioned immediately below `owner` in Server Settings so the bot can manage nicknames and assign every staff, stage, and team role below it. All functional roles are referenced by Snowflake ID inside `config.yaml`.

| Rank Tier | Role Name            | Role Type          | Hoisted | Allow `ChangeNickname` | Core Capabilities and Bot Access                                                       |
| --------- | -------------------- | ------------------ | ------- | ---------------------- | -------------------------------------------------------------------------------------- |
| 1         | `owner`              | Existing preserved | Yes     | Yes                    | Full administrative control and exclusive access to `/challenge`                       |
| 2         | `fcode-operator-bot` | Managed bot        | No      | Yes                    | Executes verification, rejoin restoration, and stage mutations                         |
| 3         | `carl-bot`           | Managed bot        | No      | Yes                    | Preserved managed bot for server audit logging                                         |
| 4         | `voice-master`       | Managed bot        | No      | Yes                    | Preserved managed bot for dynamic temporary voice channels                             |
| 5         | `ticket-tool`        | Managed bot        | No      | Yes                    | Preserved managed bot for support ticket channels                                      |
| 6         | `bot`                | Existing preserved | Yes     | Yes                    | Existing shared bot role granted read and write access to log channels                 |
| 7         | `moderator`          | Staff              | Yes     | Yes                    | Full channel access, announcement posting, member moderation, and `/student` commands  |
| 8         | `mentor`             | Staff              | Yes     | Yes                    | Access to all challenge categories, staff channels, and all team categories            |
| 9         | `supporter`          | Staff              | Yes     | Yes                    | Access to challenge categories, staff channels, ticket support, and team categories    |
| 10        | `challenge-3`        | Stage              | Yes     | No                     | Unlocks `CHALLENGE 3` channels and inherits `VOICE` access                             |
| 11        | `challenge-2`        | Stage              | Yes     | No                     | Unlocks `CHALLENGE 2` channels and inherits `VOICE` access                             |
| 12        | `challenge-1`        | Stage              | Yes     | No                     | Unlocks `CHALLENGE 1` channels, unlocks `VOICE`, and hides verification channel        |
| 13        | `team-01`, `team-02` | Team (optional)    | No      | No                     | Unlocks the matching `TEAM XX` category with chat and voice permissions                |
| 14        | `@everyone`          | Default baseline   | No      | No                     | `SendMessages` and `ChangeNickname` denied globally; views `INFORMATION` and `SUPPORT` |

---

## 2. Global `@everyone` Baseline Permissions

At the guild role level, `@everyone` disables `SendMessages`, `SendMessagesInThreads`, `CreatePublicThreads`, `CreatePrivateThreads`, `ChangeNickname`, `MentionEveryone`, and `ManageWebhooks`. Regular candidates cannot rename themselves after verification and cannot send messages outside explicitly permitted channels such as `#💬・team-discussion` and support channels.

---

## 3. Categories, Channels, and Permission Overwrite Matrix

Every channel uses Unicode 6.0 emojis paired with `kebab-case` English names so characters render consistently across legacy systems and web browsers.

| Category             | Channel                         | Channel Type | View Access (`ViewChannel`)                                                                              | Write or Voice Access (`SendMessages` or `Connect` and `Speak`)                                                                         |
| -------------------- | ------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `INFORMATION`        | `📖・rules`                     | Text         | `@everyone`                                                                                              | `owner`, `moderator`                                                                                                                    |
| `INFORMATION`        | `📢・announcements`             | Text         | `@everyone`                                                                                              | `owner`, `moderator`                                                                                                                    |
| `INFORMATION`        | `✅・verification`              | Text         | `@everyone` (explicitly denied for `challenge-1`, `challenge-2`, `challenge-3`)                          | `SendMessages` denied for candidates; `UseApplicationCommands` allowed for `@everyone`; `SendMessages` allowed for `owner`, `moderator` |
| `SUPPORT`            | `🎫・support-ticket`            | Text         | `@everyone`, `owner`, `moderator`, `supporter`, `ticket-tool`                                            | `owner`, `moderator`, `supporter`, `ticket-tool`                                                                                        |
| `VOICE`              | `👆・join-to-create`            | Voice        | `owner`, `moderator`, `mentor`, `supporter`, `voice-master`, `challenge-1`, `challenge-2`, `challenge-3` | `Connect` allowed for all listed viewers                                                                                                |
| `CHALLENGE 1`        | `📢・challenge-1-announcements` | Text         | `owner`, `moderator`, `mentor`, `supporter`, `challenge-1`, `challenge-2`, `challenge-3`                 | `owner`, `moderator`                                                                                                                    |
| `CHALLENGE 1`        | `📖・challenge-1-guidelines`    | Text         | `owner`, `moderator`, `mentor`, `supporter`, `challenge-1`, `challenge-2`, `challenge-3`                 | `owner`, `moderator`                                                                                                                    |
| `CHALLENGE 2`        | `📢・challenge-2-announcements` | Text         | `owner`, `moderator`, `mentor`, `supporter`, `challenge-2`, `challenge-3`                                | `owner`, `moderator`                                                                                                                    |
| `CHALLENGE 2`        | `📖・challenge-2-guidelines`    | Text         | `owner`, `moderator`, `mentor`, `supporter`, `challenge-2`, `challenge-3`                                | `owner`, `moderator`                                                                                                                    |
| `CHALLENGE 3`        | `📢・challenge-3-announcements` | Text         | `owner`, `moderator`, `mentor`, `supporter`, `challenge-3`                                               | `owner`, `moderator`                                                                                                                    |
| `CHALLENGE 3`        | `📖・challenge-3-guidelines`    | Text         | `owner`, `moderator`, `mentor`, `supporter`, `challenge-3`                                               | `owner`, `moderator`                                                                                                                    |
| `TEAM XX` (optional) | `📢・mentor-announcements`      | Text         | `team-XX`, `owner`, `moderator`, `mentor`, `supporter`                                                   | `owner`, `moderator`, `mentor`                                                                                                          |
| `TEAM XX` (optional) | `💬・team-discussion`           | Text         | `team-XX`, `owner`, `moderator`, `mentor`, `supporter`                                                   | `team-XX`, `owner`, `moderator`, `mentor`, `supporter` (includes `AttachFiles` and `EmbedLinks`)                                        |
| `TEAM XX` (optional) | `🔊・team-voice`                | Voice        | `team-XX`, `owner`, `moderator`, `mentor`, `supporter`                                                   | `Connect`, `Speak`, and `Stream` allowed for all listed viewers                                                                         |
| `STAFF`              | `🔒・notification`              | Text         | `owner`, `moderator`, `mentor`, `supporter`                                                              | `owner`, `moderator`, `mentor`, `supporter`                                                                                             |
| `STAFF`              | `💬・staff-discussion`          | Text         | `owner`, `moderator`, `mentor`, `supporter`                                                              | `owner`, `moderator`, `mentor`, `supporter`                                                                                             |
| `STAFF`              | `📝・bot-commands`              | Text         | `owner`, `moderator`, `mentor`, `supporter`                                                              | `owner`, `moderator`                                                                                                                    |
| `STAFF`              | `🔊・staff-meeting`             | Voice        | `owner`, `moderator`, `mentor`, `supporter`                                                              | `Connect` and `Speak` allowed for all listed viewers                                                                                    |
| `EVENT`              | Log channels                    | Text         | `owner`, `bot`, `carl-bot`, `moderator`                                                                  | `owner`, `bot`, `carl-bot`                                                                                                              |

---

## 4. Slash Command Authorization Matrix

All slash commands (`/verify`, `/student`, `/challenge`) reply publicly in the invoking channel so staff and candidates can observe command outcomes directly. Only the persistent `Verify Account` button in `#✅・verification` uses ephemeral responses to keep the verification channel clean.

| Command                 | Subcommand     | Authorized Caller                              | Purpose                                                                                                |
| ----------------------- | -------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `/verify`               | Default        | Every guild member                             | Verifies new candidates in one step or restores returning verified members with public channel replies |
| `Verify Account` button | Component      | Every guild member                             | Triggers the same one-step verification or restoration flow with ephemeral replies                     |
| `/student`              | `lookup`       | Server Owner, `ownerRoleId`, `moderatorRoleId` | Inspects stored student identity, full name, stage flags, and team name                                |
| `/student`              | `register`     | Server Owner, `ownerRoleId`, `moderatorRoleId` | Manually registers or updates a student nickname and record for support resolution                     |
| `/student`              | `reset`        | Server Owner, `ownerRoleId`, `moderatorRoleId` | Deletes a student record and strips recruitment roles for re-verification                              |
| `/challenge`            | `advance`      | Server Owner and `ownerRoleId` only            | Promotes all candidates from source stage to target stage with `exclude` or `only` filters             |
| `/challenge`            | `revoke`       | Server Owner and `ownerRoleId` only            | Bulk removes a stage role from selected members and updates SQLite                                     |
| `/challenge`            | `verify`       | Server Owner and `ownerRoleId` only            | Toggles the server verification gate (`enabled` boolean) in SQLite                                     |
| `/challenge`            | `verify-panel` | Server Owner and `ownerRoleId` only            | Posts or updates the persistent `Verify Account` panel message in a selected text channel              |
