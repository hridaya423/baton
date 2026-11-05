# Captains

A captain is a thread you talk to about a whole project: "juice up the README for the release", "how are those benchmarks looking". It splits the work into orders and hands each one to a crew thread. Crew threads are ordinary threads you can open and talk to. A captain checks each finished change with the order's done check, then has a reviewer read it.

## Start one

Open the menu on a thread and choose **Make captain**. The crew board opens beside the chat. Threads that are subagents, crew or reviewers cannot become captains.

## The crew board

The board shows every order in five columns: Queued, Running, Checking, Needs you and Done. A card shows the title, the model, the branch, the check result and the review verdict. Open details on a card for the check log and the review findings. A review by the same provider as the crew is flagged, because it is less likely to catch the crew's blind spots.

Use **Open thread** to read or steer a crew thread. **Retry** gives an order another attempt, **Drop** abandons it, and **Show dropped** brings dropped orders back into view. Dropping cannot be undone, so start a new order instead.

Crew threads sit under their captain in the sidebar with a dot for running, needs you and done. Reviewer threads stay out of the sidebar.

## Needs you

A captain asks you when it cannot decide: a choice, an approval, a one-way action, a retry limit, a stalled thread. Each question is a card with its options as buttons and a box for your own answer. The count on the captain row and the inbox button at the bottom of the sidebar show how many are waiting. The command palette's **Needs you** opens the same list across all captains.

## Pause and release

**Pause captain** holds the captain and interrupts its running crew threads. **Resume captain** lets work continue. **Release captain** turns the thread back into a normal thread and keeps its crew threads. **Make captain** on the same thread brings the captain back.

## Settings

**Settings → Captains** sets each captain's crew size, default delivery, crew access, retry limit, stall time, check timeout and review model.
