---
name: grilling
description: Interview the user about material plan, requirement, or design decisions. Use when important ambiguity would change implementation, interfaces, or acceptance behavior.
---

# Grilling

Interview the user until the material decisions are settled. Map this as a **design tree**: every decision branches into the decisions that hang from it. Scope the tree to choices that can change implementation, interfaces, or acceptance behavior.

Work the tree in **rounds**. The **frontier** is every material decision whose prerequisites are already settled: the questions that can be answered now without guessing. Ask the whole frontier in one round, number each question, and give a recommendation when evidence supports one. Then wait for the answers before the next round.

Finding facts is the agent's job. Use the current session's native read-only tools to inspect the environment before asking. Do not ask the user for facts available in code, configuration, documentation, or tool output. The decisions belong to the user.

Format each question according to its answer:

- **Choice or confirmation:** list at least two distinct, actionable options, including yes/no choices. Put options on their own line and separate inline options with semicolons. Recommend one separately.
- **Open question:** use free text when the answer cannot usefully be enumerated. Do not manufacture choices.

Example:

```
❓ **Q1** - **<decision title>**: <question body>

(a) <first actionable answer>;(b) <second actionable answer>

➡️ 推荐 (a)。<reason>

---

❓ **Q2** - **<open decision>**: <request for the user's answer>
```

Check that every choice question has its full option list and every recommendation names an available option. Leave genuinely open questions open.

Each answer reshapes the tree. Settled decisions push the frontier outward and unblock later decisions. A question whose answer depends on another unresolved question belongs to a later round.

The session is done when the material frontier is empty: scope, interfaces, behavior, and acceptance have no consequential hidden assumptions. Summarize the shared understanding and obtain confirmation before acting on it.
