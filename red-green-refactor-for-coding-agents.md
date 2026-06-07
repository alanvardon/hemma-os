# Red Green Refactor is OP With Claude Code

**Source:** https://www.youtube.com/watch?v=hYZdIwFIy-c
**Channel:** Matt Pocock
**Published:** 2026-02-23
**Duration:** 5:19

---

## Summary

Matt Pocock argues that the red-green-refactor (TDD) cycle is a natural fit for AI coding agents because it creates tight, verifiable feedback loops that are hard to fake. By instructing an agent to write one failing test at a time before implementing, you get higher-quality tests and can trust the green result without reading every line of generated code.

## Key Points

- Red-green-refactor is a ~30-year-old practice (from Kent Beck's Extreme Programming) that maps directly onto how coding agents should work.
- **Red**: write a failing test first — before the implementation, even before the DB schema or API method exists.
- **Green**: write the minimal code to make the test pass. Minimal is key — refactor comes next.
- **Refactor**: clean up the implementation safely, because the green test suite acts as a safety net.
- Instructing the agent to do **one test at a time** prevents the LLM's tendency to dump 90 tests at once and then one-shot a brittle implementation.
- Seeing the agent go red → green without touching the test gives high confidence the test is valid, reducing how much generated code you need to read.
- After the loop, a manual QA pass catches anything the tests missed and flushes out any bad tests.
- Feedback loops and code quality matter more than ever with AI — a low-quality codebase is replicated, not improved, by an LLM.

## Takeaways

- TDD isn't just a good practice — it's a control mechanism for keeping an AI agent in a stable, trustworthy state.
- The red-green sequence acts as proof: if the agent can't fake it going red and then green, you can trust the test without auditing every line.
- Strong types (TypeScript) and unit tests are forms of back pressure that prevent AI from racing ahead with low-quality solutions.
- Code quality is more important in the AI era, not less — the model will faithfully replicate whatever patterns it finds in the codebase.

## Action Points

- Add a TDD skill to your Claude Code setup that enforces one-test-at-a-time incremental loops.
- Structure the skill to: write test → confirm red → write minimal implementation → confirm green → repeat.
- After the red-green loop completes, add a step to look for refactor candidates while the test suite is green.
- Do a manual QA pass after each committed chunk to catch gaps the tests didn't cover.

## Notable Quotes

> "Feedback loops matter so, so much with AI."

> "It will be happy to play in the mud if what you have is mud."

> "LLMs love to create huge horizontal layers and then they'll try to one-shot an implementation that passes all 90 of those tests."

> "I don't necessarily read all of the implementations because I've seen it go red and then go green."

## Resources Mentioned

- **Kent Beck** — creator of Extreme Programming (XP) and the most well-known advocate of TDD.
- ***Extreme Programming Explained*** — book by Kent Beck that introduced XP and the disciplined use of unit tests.
- **Extreme Programming (XP)** — software methodology from the 90s/2000s built entirely around unit testing.
- **TypeScript** — cited as an example of strong typing that provides back pressure on AI-generated code.
- **Matt Pocock's TDD skill** — a Claude Code skill enforcing the red-green-refactor loop; available via the link in the video description.
- **Matt Pocock's newsletter** — where his videos and new agent skills are published first.
- **Matt Pocock's Claude Code course** — upcoming course mentioned at the end of the video.

---

## Transcript

Let's talk about a ridiculously easy way to get better results from a coding agent using a software practice that's like 20–30 years old at this point. This is red green refactor — or in some contexts, red green TDD. TDD stands for test-driven development. TDD's probably most prolific advocate is Mr. Kent Beck in *Extreme Programming Explained*. XP was a software practice developed in the 90s/2000s and it advocated extremely aggressive use of unit tests — or aggressive is maybe not the right word, but everything in the software practice was built around unit tests. The most disciplined form of TDD is test-first development: you write the automated test first, confirm that they fail, and then iterate on the implementation until the tests pass. And this turns out to be a fantastic fit for coding agents — I have definitely found this to be true.

But what do the red and green actually mean? Well, red essentially means write a failing test and the CI goes red. In other words, any automated types or tests that you've got on the repo will be at that point red. You've written a failing test to verify that the thing is going to work when it's built. This might be that you're fetching something from a database using some kind of SDK — you basically write that the fetch is going to work before you've even implemented the API method, before you've even implemented the DB schema. And then once that red test is in, you write a green implementation to make the CI go green again. All of your unit tests go, "Yep, tick. That looks good." The important thing is that this is minimal, because in the next step you're going to refactor the code you just wrote to make it prettier, to factor it into the shape you want. And you get the luxury of doing that because you've already made CI green — you have a set of tests that ensure the refactor doesn't break anything.

Now for experienced software engineers, you're probably going: okay, why does this matter more now than it did before? Because red green refactor has always been an amazing way to build software. So why are we talking about it in the AI age? Well, I find it really comforting when I see an agent doing red green refactor. Imagine this sequence: the agent writes a failing test, I can see in the CI or in the agent's output that the test failed, then I see it write an implementation — it doesn't change anything about the test, doesn't try to fake it to make it pass — and the test goes green. If it's a reasonable agent, it's pretty hard for it to fake that. And this means I don't end up reading all of the tests that are created during the red green refactor loop. I maybe skim them — especially just the titles to understand what is being tested — but I don't necessarily read all of the implementations because I've seen it go red and then go green. I feel pretty confident it's testing what it's supposed to.

And of course, once the loop is over and it's committed to the branch, I then go and QA that chunk of work so I catch anything the tests might have missed. At that point I can generally flush out any bad tests if there are any. To make this work, I have a TDD skill that I invoke when I'm building these features. The main focus of the skill is the red green refactor approach: do an incremental loop for each remaining behaviour — write the next test, see that it fails, write the minimal code to pass. The rules are that it should only do one test at a time.

I find that this is a really important caveat because it means you don't end up with a huge splurge of tests. This is one thing that LLMs love to do: they love to create huge horizontal layers and then try to one-shot an implementation that passes all 90 of those tests in one massive file edit. Now that's possible, but you do end up with a lot of crap tests. So just getting it to focus on the thing it's implementing at the time and writing a single test for that — then writing the implementation, another test, another implementation, another test, another implementation — you end up with tests that are really important for actually guiding the implementation. This one-test-at-a-time idea is really focused on improving the quality of your tests. Then once I'm done with the incremental loop, I say: after all tests pass, look for refactor candidates. But that's probably the topic for another video.

Red green refactor is a thing you have to know how to do with AI. And unsaid throughout this whole video is the fact that feedback loops matter so, so much with AI. Because AI is so eager to create code and find the fastest solution to your problem, you need to impose some back pressure on it to keep it in a stable state. Strong types like TypeScript, or unit tests, can really assist you in getting high-quality code. Code quality is actually more important than ever — if you've got a low-quality codebase, the LLM is going to replicate what it sees. Just like any developer, it will be happy to play in the mud if what you have is mud.

If you're enjoying this content, check out the newsletter linked below to get new agent skills first. A Claude Code course is also in the works — stay tuned.
