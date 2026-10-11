/**
 * The digital-goods catalog as TUFTE storefront items. TUFTE owns the
 * presentation (tiles, search, facets, detail pages, native-form actions);
 * this module only says what a reader should see about each offering, and
 * receives the actions its receiver has already decided (buy, download, gift,
 * or an honest refusal).
 */
import { htmlElement as element } from "@red-cup-engineering/web-page-tiling-engine/composition";

import { aiDisclosureFor } from "./retail-listings.mjs";

const KIND_LABELS = Object.freeze({ book: "Books", merch: "Merch" });

/** A reader-facing price, e.g. "$9.00". */
const HOUSE_BYLINES = new Set(["561 Group", "Causeway Services"]);

export function displayPrice(priceCents, currency) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: String(currency).toUpperCase() }).format(priceCents / 100);
}

function kilobytes(bytes) {
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("en-US")} KB`;
}

const counted = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function formatsOf(book) {
  return (book?.edition?.files ?? []).map((file) => file.format);
}

function facts(offering) {
  const book = offering.book;
  const rows = [];
  if (offering.priceCents != null) rows.push({ label: "Price", value: displayPrice(offering.priceCents, offering.currency) });
  if (formatsOf(book).length) rows.push({ label: "Formats", value: formatsOf(book).join(" and ") });
  if (book?.contents?.length) rows.push({ label: "Length", value: `${book.contents.length} parts${book.edition?.pages ? `, ${book.edition.pages} pages` : ""}` });
  if (book?.series) rows.push({ label: "Series", value: `${book.series.name}, number ${book.series.number}`, detailOnly: true });
  if (book?.author) rows.push({ label: "Author", value: book.author, detailOnly: true });
  if (book?.edition?.acceptedAt) rows.push({ label: "Edition accepted", value: book.edition.acceptedAt.slice(0, 10), detailOnly: true });
  return rows;
}

function detailNodes(offering) {
  const book = offering.book;
  if (!book) return [];
  const nodes = [];
  const files = book.edition?.files ?? [];
  if (files.length) {
    nodes.push(element("h3", {}, ["What you receive"]));
    nodes.push(element("p", {}, [`One download holding the ${files.map((file) => `${file.format} (${kilobytes(file.bytes)})`).join(" and ")} of the accepted edition. Your library always serves the newest accepted edition, so a corrected edition reaches you at no charge.`]));
  }
  if (book.contents?.length) {
    nodes.push(element("h3", {}, ["Contents"]));
    nodes.push(element("ol", {}, book.contents.map((title) => element("li", {}, [title]))));
  }
  nodes.push(element("h3", {}, ["How it was made"]));
  nodes.push(element("p", {}, [aiDisclosureFor(offering).text.replace(/^AI-generated: t/u, "T")]));
  const edition = book.edition;
  if (edition?.digest) {
    nodes.push(element("h3", {}, ["Verification record"]));
    const proof = edition.proof;
    nodes.push(element("p", {}, [proof
      ? `An independent proofreading agent, not the one that wrote it, read ${proof.carried ? "this text" : "this edition"} and reported ${counted(proof.errors, "error")}, ${counted(proof.corrections, "correction")} and ${counted(proof.notes, "note")}; each was fixed, or answered with a reason, and checked against the final files before the edition was accepted.${proof.carried ? " This edition was rebuilt so that anyone can reproduce its files from the manuscript; its text was checked, mechanically, to be the one the proofreading agent read." : ""}`
      : "This edition predates the house's acceptance records; its download names the release it delivers."]));
    nodes.push(element("dl", {}, [
      element("dt", {}, ["Edition digest"]), element("dd", {}, [element("code", {}, [edition.digest])]),
      ...files.flatMap((file) => [element("dt", {}, [`${file.format} SHA-256`]), element("dd", {}, [element("code", {}, [file.sha256])])]),
    ]));
    if (files.length) nodes.push(element("p", {}, ["Check your copy: the SHA-256 of each file you download (for example with ", element("code", {}, ["sha256sum"]), ") is the value above, the same bytes the proofreading agent read."]));
  }
  return nodes;
}

/** The schema.org description of one offering, for search engines and link previews. */
export function structuredDataFor(offering, { origin, href, image }) {
  // An offer is stated only while it can be taken: an unarmed checkout is not a
  // preorder, and a search engine told otherwise would list a price no one can pay.
  const offer = offering.priceCents != null && offering.buyable ? {
    "@type": "Offer", price: (offering.priceCents / 100).toFixed(2), priceCurrency: String(offering.currency).toUpperCase(), url: `${origin}${href}`,
    availability: "https://schema.org/InStock",
  } : undefined;
  const book = offering.book;
  // A named author is a person on the page (a fictional one is still a byline);
  // only a book with no author is the Group's own.
  // House imprints are organizations; any other named author is a person.
  const author = book?.author && !HOUSE_BYLINES.has(book.author) ? { "@type": "Person", name: book.author } : { "@type": "Organization", name: book?.author ?? "561 Group" };
  return {
    "@context": "https://schema.org",
    "@type": book ? "Book" : "Product",
    name: offering.title,
    ...(offering.subtitle ? { alternativeHeadline: offering.subtitle } : {}),
    ...(offering.blurb ? { description: offering.blurb } : {}),
    url: `${origin}${href}`,
    ...(image ? { image: `${origin}${image}` } : {}),
    ...(book ? { bookFormat: "https://schema.org/EBook", author, ...(book.publisher ? { publisher: { "@type": "Organization", name: book.publisher } } : {}), inLanguage: "en" } : {}),
    ...(book?.series ? { isPartOf: { "@type": "BookSeries", name: book.series.name }, position: book.series.number } : {}),
    ...(offer ? { offers: offer } : {}),
  };
}

/**
 * One offering as a TUFTE storefront item.
 * @param {object} offering an offering view model (catalogModel)
 * @param {{actions?: object[], cover?: string, status?: {label: string, note?: string}}} [options]
 */
export function storefrontItemFor(offering, { actions = [], cover, status } = {}) {
  const book = offering.book;
  return {
    id: offering.id,
    title: offering.title,
    eyebrow: book?.series ? `${book.series.name} · ${book.series.number}` : undefined,
    summary: offering.blurb ?? offering.subtitle ?? undefined,
    ...(cover ? { image: { src: cover, alt: `Cover of ${offering.title}` } } : {}),
    ...(status ? { status } : {}),
    facts: facts(offering),
    keywords: offering.keywords,
    facets: { kind: [book ? "book" : offering.line === "merch" ? "merch" : "other"], ...(book?.series ? { series: [book.series.name] } : {}) },
    detail: detailNodes(offering),
    actions,
  };
}

/** The catalog's facets, labelled for readers. */
export function storefrontFacets(items) {
  const facets = [{ key: "kind", label: "Kinds", labels: KIND_LABELS }];
  if (items.some((item) => item.facets.series)) facets.push({ key: "series", label: "Series" });
  return facets;
}
