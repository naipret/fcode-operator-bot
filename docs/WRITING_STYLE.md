# Engineering Writing Style Guide

This style guide establishes standards for technical prose across project documentation, architectural records, pull requests, and commit summaries. It preserves high information density and eliminates formulaic patterns common in generated text.

---

## 1. Principles of Technical Voice

Technical writing exists to inform engineers with clarity and precision.

- State facts and mechanisms directly without introductory filler clauses.
- Use the active voice and identify the component performing the action.
- Maintain an objective, neutral tone without subjective praise or marketing adjectives.
- Conclude a section once the technical explanation is complete without appending summary paragraphs.
- Omit decorative emojis in technical prose, headings, and lists. Literal Discord channel names that contain Unicode characters appear only inside inline code spans.

---

## 2. Typography and Visual Noise

Formatting clarifies structural hierarchy and must never simulate emotional emphasis.

### Prohibition of Mid-Sentence Bold Text

Do not bold words inside running sentences for emphasis. Bold styling is reserved strictly for table column headers, warning labels, and the single initial definition of an unfamiliar term.

### Prohibition of Bold-Prefix Bullet Lists

Do not prefix bulleted items with a bolded noun followed by a colon. Write complete sentences or use a structured comparison table.

| Component                | Responsibility                                                                   |
| ------------------------ | -------------------------------------------------------------------------------- |
| `ConfigLoader`           | Parses and validates `.env` and `config.yaml` against `ConfigSchema` at startup. |
| `StudentRepository`      | Executes SQLite read and write operations on the `students` table.               |
| `VerificationController` | Validates student identity and synchronizes Discord member state.                |

### Inline Code Spans

Wrap exact system identifiers in single backticks. This rule applies to file paths, function signatures, class names, variables, environment variables, commands, configuration keys, and Discord role or channel names. Do not wrap ordinary English words or abstract architectural concepts in backticks.

---

## 3. Punctuation and Mechanical Rules

### Ampersands

Spell out the word "and" in regular prose. The ampersand character is permitted only inside programming language operators, formal trademarked names, and narrow table column headers.

### Slashes

Do not join nouns or adjectives with slashes in prose. Write "roles and channels" rather than "roles/channels", and write "creation and update" rather than "creation/update". Slashes remain valid inside file paths, URLs, and Discord slash commands such as `/verify`.

### Parentheses

State critical technical constraints directly in the main clause rather than hiding requirements inside parenthetical remarks.

---

## 4. Anti-Patterns and Required Revisions

| Pattern                              | Defect                     | Required Revision                                     |
| ------------------------------------ | -------------------------- | ----------------------------------------------------- |
| "It is important to note that..."    | Empty throat-clearing      | Begin directly with the subject.                      |
| "Plays a crucial role in..."         | Vague importance           | Name the exact function, interface, or data flow.     |
| "Seamless", "robust", "cutting-edge" | Unsubstantiated praise     | State concrete limits, latency bounds, or invariants. |
| "In order to..."                     | Wordy prepositional phrase | Replace with "to".                                    |
| "In summary", "In conclusion"        | Redundant wrap-up          | Delete the closing paragraph entirely.                |
