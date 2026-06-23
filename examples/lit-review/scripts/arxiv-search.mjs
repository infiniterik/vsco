#!/usr/bin/env node
// Search arXiv and print structured, plain-text results for the ReAct agent.
//
// The agent invokes this through its run_command tool, e.g.:
//   node examples/lit-review/scripts/arxiv-search.mjs "speculative decoding" 6
//
// Output is plain text (not JSON) so it reads cleanly when fed back as an
// Observation to a no-tool-calling model.

const query = process.argv[2];
const max = Math.min(parseInt(process.argv[3] ?? "8", 10) || 8, 25);

if (!query) {
  console.error('Usage: arxiv-search.mjs "<query>" [maxResults]');
  process.exit(2);
}

const url =
  "http://export.arxiv.org/api/query?search_query=" +
  encodeURIComponent(`all:${query}`) +
  `&start=0&max_results=${max}&sortBy=relevance&sortOrder=descending`;

function decode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? decode(m[1]) : "";
}

function allTags(block, name) {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(block))) out.push(decode(m[1]));
  return out;
}

try {
  const res = await fetch(url, {
    headers: { "User-Agent": "react-hooks-agent-litreview/0.1" },
  });
  if (!res.ok) {
    console.error(`arXiv request failed: HTTP ${res.status}`);
    process.exit(1);
  }
  const xml = await res.text();
  const entries = xml
    .split("<entry>")
    .slice(1)
    .map((e) => e.split("</entry>")[0]);

  if (!entries.length) {
    console.log(`No arXiv results for: ${query}`);
    process.exit(0);
  }

  console.log(`# arXiv results for: ${query} (${entries.length})\n`);
  entries.forEach((e, i) => {
    const title = tag(e, "title");
    const summary = tag(e, "summary");
    const published = tag(e, "published").slice(0, 10);
    const id = tag(e, "id");
    const authors = allTags(e, "name").slice(0, 8).join(", ");
    const cats = (e.match(/term="([^"]+)"/g) || [])
      .map((c) => c.slice(6, -1))
      .slice(0, 4)
      .join(", ");
    const abstract = summary.length > 600 ? `${summary.slice(0, 600)}…` : summary;

    console.log(`## [${i + 1}] ${title}`);
    console.log(`- Published: ${published}`);
    console.log(`- Authors: ${authors}`);
    if (cats) console.log(`- Categories: ${cats}`);
    console.log(`- Link: ${id}`);
    console.log(`- Abstract: ${abstract}\n`);
  });
} catch (err) {
  console.error(`arXiv search error: ${err}`);
  process.exit(1);
}
