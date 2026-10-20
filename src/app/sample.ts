/** A made-up, realistically messy bookmarks export so anyone can try the app in one click. */
const BAR: [string, string][] = [
  ["Gmail", "https://mail.google.com/mail/u/0/"],
  [
    "Easy Weeknight Chicken Tacos",
    "https://www.example-recipes.com/chicken-tacos?utm_source=pinterest&utm_medium=social",
  ],
  [
    "MDN Web Docs: Array.prototype.map()",
    "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map",
  ],
  ["localhost:4200", "http://localhost:4200/"],
  [
    "Cheap flights to Denver",
    "https://www.example-flights.com/denver?ref=newsletter",
  ],
  ["Angular Signals guide", "https://angular.dev/guide/signals"],
  ["Remote frontend jobs", "https://www.example-jobs.com/remote-frontend"],
];
const FOLDERS: Record<string, [string, string][]> = {
  Stuff: [
    [
      "Sheet pan salmon and veggies",
      "https://www.example-recipes.com/sheet-pan-salmon",
    ],
    ["How to keep basil alive", "https://www.example-garden.com/basil-care"],
    [
      "CSS Grid complete guide",
      "https://css-tricks.com/snippets/css/complete-guide-grid/",
    ],
    [
      "Best hiking boots 2026 review",
      "https://www.example-gear.com/hiking-boots-review",
    ],
    [
      "Easy Weeknight Chicken Tacos",
      "https://example-recipes.com/chicken-tacos/",
    ],
    [
      "Budget spreadsheet template",
      "https://www.example-money.com/budget-template",
    ],
    [
      "Dog-friendly patios near me",
      "https://www.example-city.com/dog-friendly-patios",
    ],
    [
      "TypeScript handbook",
      "https://www.typescriptlang.org/docs/handbook/intro.html",
    ],
  ],
  "Read later": [
    [
      "Why we sleep less in the fall",
      "https://www.example-news.com/science/sleep-fall",
    ],
    [
      "The quiet power of slow mornings",
      "https://medium.com/@example/slow-mornings-123",
    ],
    ["Web performance in 2026", "https://web.dev/articles/performance-2026"],
    [
      "Long read: the history of the bookmark",
      "https://www.example-news.com/culture/bookmark-history",
    ],
    ["10 cozy fall reads", "https://www.example-books.com/cozy-fall-reads"],
    [
      "Accessibility checklist for frontend devs",
      "https://www.example-a11y.com/checklist",
    ],
  ],
  "NEW FOLDER": [
    [
      "Flight + hotel deals Asheville",
      "https://www.example-flights.com/asheville",
    ],
    [
      "Airbnb cabins in the mountains",
      "https://www.example-stays.com/mountain-cabins",
    ],
    ["National park day passes", "https://www.example-parks.gov/passes"],
    ["Cheap flights to Denver", "http://example-flights.com/denver"],
  ],
  "misc 2": [
    [
      "Interview prep: behavioral questions",
      "https://www.example-jobs.com/behavioral-questions",
    ],
    ["Salary calculator", "https://www.example-money.com/salary-calculator"],
    [
      "Resume template (frontend)",
      "https://www.example-jobs.com/resume-frontend",
    ],
    [
      "LinkedIn profile tips",
      "https://www.linkedin.com/pulse/profile-tips-example",
    ],
    ["Old project staging", "http://127.0.0.1:8080/"],
    ["Yoga for desk workers", "https://www.youtube.com/watch?v=example123"],
    ["Lo-fi beats to code to", "https://www.youtube.com/watch?v=example456"],
    [
      "Weekly meal prep ideas",
      "https://www.example-recipes.com/meal-prep?fbclid=abc123",
    ],
    ["Online pharmacy refill", "https://www.example-pharmacy.com/refill"],
    ["Pet insurance comparison", "https://www.example-pets.com/insurance"],
    [
      "Halloween events this weekend",
      "https://www.example-city.com/halloween-events",
    ],
    ["Movie times", "https://www.example-movies.com/showtimes"],
    [
      "Git cheat sheet",
      "https://education.github.com/git-cheat-sheet-education.pdf",
    ],
    ["Regex tester", "https://regex101.com/"],
    ["Can I use", "https://caniuse.com/"],
    ["Weekend farmers market", "https://www.example-city.com/farmers-market"],
  ],
};

export function sampleHtml(): string {
  const a = ([t, u]: [string, string]) =>
    `        <DT><A HREF="${u.replace(/&/g, "&amp;")}" ADD_DATE="1700000000">${t}</A>`;
  return [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>",
    "<DL><p>",
    '    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>',
    "    <DL><p>",
    ...BAR.map(a),
    ...Object.entries(FOLDERS).flatMap(([name, items]) => [
      `        <DT><H3>${name}</H3>`,
      "        <DL><p>",
      ...items.map((x) => "    " + a(x)),
      "        </DL><p>",
    ]),
    "    </DL><p>",
    "</DL><p>",
  ].join("\n");
}
