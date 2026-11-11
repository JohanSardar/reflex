---
kind: recipe
name: week-planner
summary: A week calendar of draggable time blocks (Mon–Sun, 08:00–20:00) and a handwritten journal Region.
---
# week-planner

Lays out an empty week: seven day columns (`day-mon` … `day-sun`), 150 wide, from 08:00 at their
top to 20:00 at their bottom (50 per hour), with hour labels, and a Journal Region below with a Send
button. Then add one time block per event: read_me("planning") gives the geometry, the block op
and how to turn the person's drags back into times for their calendar.

Pass `date_mon` … `date_sun` to show dates after the day names, such as " 16".

## Params

```json params
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "maxLength": 80,
      "default": "This week"
    },
    "date_mon": {
      "type": "string",
      "maxLength": 12,
      "default": ""
    },
    "date_tue": {
      "type": "string",
      "maxLength": 12,
      "default": ""
    },
    "date_wed": {
      "type": "string",
      "maxLength": 12,
      "default": ""
    },
    "date_thu": {
      "type": "string",
      "maxLength": 12,
      "default": ""
    },
    "date_fri": {
      "type": "string",
      "maxLength": 12,
      "default": ""
    },
    "date_sat": {
      "type": "string",
      "maxLength": 12,
      "default": ""
    },
    "date_sun": {
      "type": "string",
      "maxLength": 12,
      "default": ""
    },
    "button": {
      "type": "string",
      "minLength": 1,
      "maxLength": 40,
      "default": "Save my day"
    }
  },
  "additionalProperties": false
}
```

## Template

```json template
[
  {"op": "add", "type": "frame", "id": "week", "title": "{{title}}", "w": 1130, "h": 680},
  {"op": "add", "type": "frame", "id": "day-mon", "title": "Mon{{date_mon}}", "w": 150, "h": 600, "at": {"inside": "week", "gap": 60}},
  {"op": "add", "type": "frame", "id": "day-tue", "title": "Tue{{date_tue}}", "w": 150, "h": 600, "at": {"right_of": "day-mon", "gap": 0}},
  {"op": "add", "type": "frame", "id": "day-wed", "title": "Wed{{date_wed}}", "w": 150, "h": 600, "at": {"right_of": "day-tue", "gap": 0}},
  {"op": "add", "type": "frame", "id": "day-thu", "title": "Thu{{date_thu}}", "w": 150, "h": 600, "at": {"right_of": "day-wed", "gap": 0}},
  {"op": "add", "type": "frame", "id": "day-fri", "title": "Fri{{date_fri}}", "w": 150, "h": 600, "at": {"right_of": "day-thu", "gap": 0}},
  {"op": "add", "type": "frame", "id": "day-sat", "title": "Sat{{date_sat}}", "w": 150, "h": 600, "at": {"right_of": "day-fri", "gap": 0}},
  {"op": "add", "type": "frame", "id": "day-sun", "title": "Sun{{date_sun}}", "w": 150, "h": 600, "at": {"right_of": "day-sat", "gap": 0}},
  {"op": "add", "type": "text", "id": "hour-08", "text": "08:00", "size": "s", "w": 48, "h": 50, "at": {"left_of": "day-mon", "gap": 8}},
  {"op": "add", "type": "text", "id": "hour-09", "text": "09:00", "size": "s", "w": 48, "h": 50, "at": {"below": "hour-08", "gap": 0}},
  {"op": "add", "type": "text", "id": "hour-10", "text": "10:00", "size": "s", "w": 48, "h": 50, "at": {"below": "hour-09", "gap": 0}},
  {"op": "add", "type": "text", "id": "hour-11", "text": "11:00", "size": "s", "w": 48, "h": 50, "at": {"below": "hour-10", "gap": 0}},
  {"op": "add", "type": "text", "id": "hour-12", "text": "12:00", "size": "s", "w": 48, "h": 50, "at": {"below": "hour-11", "gap": 0}},
  {"op": "add", "type": "text", "id": "hour-13", "text": "13:00", "size": "s", "w": 48, "h": 50, "at": {"below": "hour-12", "gap": 0}},
  {"op": "add", "type": "text", "id": "hour-14", "text": "14:00", "size": "s", "w": 48, "h": 50, "at": {"below": "hour-13", "gap": 0}},
  {"op": "add", "type": "text", "id": "hour-15", "text": "15:00", "size": "s", "w": 48, "h": 50, "at": {"below": "hour-14", "gap": 0}},
  {"op": "add", "type": "text", "id": "hour-16", "text": "16:00", "size": "s", "w": 48, "h": 50, "at": {"below": "hour-15", "gap": 0}},
  {"op": "add", "type": "text", "id": "hour-17", "text": "17:00", "size": "s", "w": 48, "h": 50, "at": {"below": "hour-16", "gap": 0}},
  {"op": "add", "type": "text", "id": "hour-18", "text": "18:00", "size": "s", "w": 48, "h": 50, "at": {"below": "hour-17", "gap": 0}},
  {"op": "add", "type": "text", "id": "hour-19", "text": "19:00", "size": "s", "w": 48, "h": 50, "at": {"below": "hour-18", "gap": 0}},
  {"op": "add", "type": "region", "id": "journal", "title": "Journal", "send_button": "{{button}}", "w": 1130, "h": 380, "at": {"below": "week", "gap": 40}},
  {"op": "add", "type": "note", "id": "how", "color": "yellow", "w": 300, "text": "Drag a block to move it; it snaps to the half hour. Write in the journal by hand, then press {{button}}.", "at": {"right_of": "week", "gap": 40}}
]
```

## Example

```json example
{"title": "Week of 16 Nov", "date_mon": " 16", "date_tue": " 17", "date_wed": " 18", "date_thu": " 19", "date_fri": " 20", "date_sat": " 21", "date_sun": " 22", "button": "Save my day"}
```
