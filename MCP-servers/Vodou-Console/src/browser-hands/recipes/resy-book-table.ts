import type { Recipe } from '../recipe.js';

/**
 * resy.com / book-table — the first errand (PLAN-BROWSER-HANDS §9 H1; decision 5
 * named OpenTable, but OpenTable's bot wall answers "Access Denied" to an
 * automated browser on its search page, measured 2026-09-28 — it waits for
 * backend 1, the person's own Chrome).
 *
 * Written from real Resy pages captured 2026-09-28 (read-only; nothing booked):
 *   - search: /cities/<city>/search?query=&date=&seats= lists each restaurant as
 *     a link with its exact name, and its open times as buttons "5:00 PM DINNER";
 *   - the venue page keeps date/seats from the link, shows the same time buttons,
 *     or "Notify for Dinner" and "Sorry, we don't currently have any tables…";
 *   - a time opens a dialog "Complete Your Reservation" (in an iframe) holding
 *     restaurant, date, time and party — the approval summary — and "Reserve Now";
 *   - signed out, a "Log in" button shows; Resy signs in with a phone number and
 *     a texted code, which the loop handles by asking the person.
 * "Reserve Now" is gated by the contract (book), so the person approves the
 * exact summary with a screenshot before it is clicked.
 */
export const resyBookTable: Recipe = {
  id: 'resy.com/book-table',
  version: 1,
  site: { domains: ['resy.com'], needs_login: true },
  task: 'Book a table on Resy',
  slots: {
    city: "Resy's city slug: city-state, lowercase, hyphens (new-york-ny, los-angeles-ca, chicago-il, miami-fl, san-francisco-ca, washington-dc)",
    restaurant: 'the restaurant name as the person said it',
    date: 'YYYY-MM-DD',
    party_size: 'number of guests',
    time_window: 'optional, 24h "HH:MM-HH:MM" around when they want to eat, e.g. "18:30-20:30"',
  },
  required: ['city', 'restaurant', 'date', 'party_size'],
  steps: [
    { do: 'navigate', url: 'https://resy.com/cities/{city}/search?query={restaurant}&date={date}&seats={party_size}' },
    { expect: { role: 'link', name_matches: '{restaurant}' }, within_ms: 15_000 },
    { do: 'click', target: { role: 'link', name_matches: '{restaurant}' } },
    { expect: { role: 'heading', name_matches: '{restaurant}' }, within_ms: 15_000 },
    { expect: { text_matches: '\\d{1,2}:\\d{2} [AP]M [A-Z]|Notify for|any tables available' }, within_ms: 15_000 },
    {
      do: 'pick_options',
      from: { role: 'button', name_matches: '^\\d{1,2}:\\d{2} [AP]M\\b' },
      keep: 5,
      filter: 'time_window',
      ask: '{restaurant} has these times on {date} for {party_size}. Which one?',
      none: '{restaurant} has no open tables for {party_size} on {date} on Resy.',
    },
    { do: 'click', target: { role: 'button', name_matches: '^{chosen_option}$' } },
    { expect: { role: 'dialog', name_matches: 'Complete Your Reservation' }, within_ms: 10_000 },
    {
      when_present: { role: 'button', name_matches: '^Log in$' },
      fallback: 'Resy needs the person signed in before booking. They were asked for the phone number on their Resy account: click "Log in", enter it, then ask them for the code Resy texts them, then finish the booking',
      ask: "Resy needs you signed in to book (once — Vodou's browser remembers it). What's the phone number on your Resy account?",
    },
    { do: 'click', target: { role: 'button', name_matches: '^Reserve Now$' } },
    { expect: { text_matches: "confirmed|you're all set|see you|reservation details|booked" }, within_ms: 20_000 },
    { proof: true, text: 'Booked {restaurant}: {chosen_option} on {date} for {party_size}.' },
  ],
};
