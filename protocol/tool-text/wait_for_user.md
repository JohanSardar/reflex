Wait until the person sends you something, and return it as a Send Bundle: their words (said, with Mark IDs such as [m1] placed where they drew while speaking), their Marks with the Element IDs each one points at, what they changed, the nearby scene, and images of the marked areas.

Pass after: the ID of the last Send you handled; that acknowledges it. If the timeout passes first you get status: "still_waiting"; call again with the same arguments. timeout_s: 0 returns at once with the oldest waiting Send, which is how you read your Inbox.

kind says what you got. "send": the person's turn is over, so answer it. "tap": they used one of your Behaviors and are still working. "watch": a snapshot of a Region you watch; user_still_writing says whether they are mid-stroke, so hold back until they finish. redelivered: true means you saw this Send before but didn't acknowledge it.

text_guess is only a hint. When the handwriting matters, read it from the image.
