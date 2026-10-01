---
name: fill-this-form-from-profile
description: Fills in the form on screen from the user's saved profile (name, address, email, phone), with their OK for each field.
when_to_use: The user asks to fill in, complete or auto-fill a form with their details.
version: 1.0.0
author: Lumen
triggers: ['fill this form', 'fill in this form', 'fill this in for me']
permissions:
  input: true
  profile: true
  risky: true
tools: [observe, act, ask_user, finish]
---

1. Observe the screen and list the form's fields.
2. Match each field to a profile fact (name, address, email, phone, date of birth). Only use facts from the profile; never guess.
3. Never fill passwords, card numbers, security codes, bank details or government ID numbers. Leave those to the user.
4. Fill the matched fields with set_value. Ask the user for any required field the profile does not have.
5. Never press Submit, Send or Pay. Finish with which fields are filled and what is left for the user.
