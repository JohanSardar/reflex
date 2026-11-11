---
kind: guide
name: planning
summary: Weekly planning and journal: time blocks the person drags, a handwritten journal, and updating their calendar from what they moved and wrote.
---
# Weekly planning and journal

You lay out the person's week as time blocks. They drag blocks to other days and times, write a
journal entry by hand, and Send. You turn their moves into calendar changes and their journal into
notes, and update the calendar.

## Set it up

1. `recipe("week-planner", {title: "Week of 16 Nov", date_mon: " 16", …}, at: {x: 0, y: 0})`.
2. `read(space, ids: ["day-mon"])` for the Monday column's bounds `[X, Y, 150, 600]`. Columns sit
   side by side, 150 wide: day d (0 = Mon … 6 = Sun) starts at x = X + 150·d. The top is 08:00,
   and every hour is 50 tall: hour h starts at y = Y + 50·(h − 8).
3. Add one block per event, 138 wide, inset 6, 50 tall per hour, draggable and snapping to the
   columns on the half hour, with the event in `data`, and a `drag_end` → `notify` Behavior so you
   hear each move:

```json
{ "op": "add", "id": "evt-standup", "type": "shape", "shape": "rounded", "fill": "tint", "color": "blue",
  "text": "Team standup\n09:30–10:00", "w": 138, "h": 25, "at": { "x": 306, "y": 135 },
  "draggable": true, "snap": { "to": ["day-mon", "day-tue", "day-wed", "day-thu", "day-fri", "day-sat", "day-sun"], "grid": 25 },
  "data": { "event": "standup-1118", "start": "2026-11-18T09:30", "end": "2026-11-18T10:00" },
  "behaviors": [ { "on": "drag_end", "do": "notify", "payload": { "event": "standup-1118" } } ] }
```

Use the person's real calendar for the events when you can read it (a file, a CLI, an API); else
ask them for the week.

## Read their changes

- Each drag arrives as a `tap` (`element`, `payload`) and again in the next Send's `changes` as
  `{kind: "moved", id, by: [dx, dy]}`. The new time: read the block's bounds `[x, y, w, h]`;
  day = round((x − 6 − X) / 150), start = 08:00 + (y − Y) / 50 hours, length = h / 50 hours.
- The journal arrives as `writing` Marks, one per line, from the Journal Region's button
  (`trigger: "region"`, `region: "journal"`); a line with low `confidence` deserves a look at its
  image.

## Update the calendar

1. For each moved block, change the event's time in the person's calendar (an `.ics` file, a CLI,
   an API), patch the block's `text` and `data` to the new time, and list what moved.
2. Turn the journal into a dated entry: what they did, what's on their mind, and anything that
   should become an event or a task. Ask before adding events they didn't drag.
3. Answer with one short note next to the journal: what changed in the calendar, and what you
   noted.
