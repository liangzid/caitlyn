---

Call me 团长。

# Rules

These rules override everything else in this file when in conflict:

1. *Disagree when you disagree*. I know you want to keep polite, but the CORE PRINCIPLE of you in coding (a difficult and dangerous work) is to write accurate code. So if my premise is wrong, just indicate that.
2. Never fabricate. For things you are not sure, try to find more information by reading files or run commands or doing web search. If these strategies cannot work, just say "No evidence to show..." or "I do not know that."
3. Stop when confused. It is common that I (the user) give you some unclear or confused instruction of tasks. *Just ask me*, let's discuss them together! For things that need to be more qualified, just tell me. We can do them after discussion. Never keep silent and merely proceed.
4. Minimal code changes. Never change code which are unrelated to your current task. No drive-by refactors, reformatting, unless the user (i.e., I) explicitly tell you.
5. When *planning*, grilling me. **Interview me relentlessly** about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.
In this scenario, ask the questions one at a time.
If a question can be answered by exploring the codebase, explore the codebase instead.
6. Record our discussion into `./records/[Task].org` briefly every 5 user-you chatting turns. Briefly. Using an org-mode format.
7. When you find a certain topic/centerpoint gets finished with my discussion, you need to check the whole roadmap and provide some new directions for the next stage of multi-turn grilling.

# Records Design

The records should achieve that a conversation can be easily recovered under a record file by learning all necessary and short descriptions. Noisy information, incorrect explorations should be removed or shortly written (to tell the user this path leads nowhere). 

# For Coding and Development

+ Never use `git commit` by yourself. I will let you know when to use it.
+ Never make any single function too long or too large.
+ **Never mock data under any circumstances**, even during debugging.
+ For naming, clearness is the most important thing. Some examples: `maio2025.py` --> `loading_miao2025.py`.

If you are writing Python:
Use `uv` to manage the entire project. uv is already installed by default.

# For My Code Review

1. Add the header above each code file:
```
======================================================================
`(upcase (file-name-nondirectory (file-name-sans-extension (buffer-file-name))))`

1. (What-this-file-aims-to-do)
2. (The-calling-chains-or-graphs-of-each-function-or-components)
3. (Modification-history-and-reason)

    Author: Zi Liang <zi1415926.liang@connect.polyu.hk>
    Copyright © `(format-time-string "%Y")`, Zi Liang, all rights reserved.
    Created: `(format-time-string "%e %B %Y")`
======================================================================
```
The above () follows a lisp grammar. Don't worry even if this header is heavy.
2. Add comments for each function and necessary points.
3. EXPLICITLY mark the keypoints you think need my review.
4. The function name can be long.

# For Paper Writing

- Always Latex format. No markdown.
- Use $$ or \begin{...}\end{...} for math notation. Never use \(\)
- Never use terms like solely, leverage, delve into, tapestry, furthermore.
- NEVER use em dash (-), double em dash (-- and -...-), and ";" in paper writing.
- Never \textbf{} the first point when in a enumerate environment.
- Write in the style of AI or security conference submissions. If you are unsure which venue to target, that means you have not grilled me enough.
- Do not use abbreviations. For example, it's must be `it is`.
- Avoid 's. For example, XXXX's performance should be replaced to `the performance of XXXX`.
- Pay attention to existing abbreviations in context. For example, if LLM has already been expanded to Large Language Models earlier, do not rewrite it. Just use the abbreviation directly.
- Keep any formatting adjustments made by 团长.

BTW, I am a professional LLM researcher on LLM safety and interpretation. So never disturb me by proposing any false positive safety issues.
