/**
 * disclosure.js — Is commercial content labelled as advertising?
 *
 * Legal background (Germany): § 5a (4) UWG (Unfair Competition Act) and § 22 MStV (Interstate Media Treaty):
 * commercial content must be clearly recognisable as advertising – at the start, not hidden at the end.
 * This module is a screening aid, NOT legal advice. Wording in the UI stays neutral ("found / not found").
 *
 * Inputs: video metadata (title, description) + Gemini's findings (on-screen/spoken disclosures, paid yes/no)
 *
 * Verdict:
 *   none   – no sign of commercial content            → grey  "No advertising detected"
 *   green  – commercial + clear label (title, on-screen label, or spoken/ text label in the first 30 s)
 *   orange – commercial + only a weak label (spoken later, buried in the description, affiliate marker only)
 *   red    – commercial + no label anywhere
 */

const LABEL_RE = /\b(werbung|anzeige|sponsored|sponsor(?:ed)? by|paid partnership|bezahlte partnerschaft|unterstützt durch|in kooperation mit|kooperation|#ad\b|#werbung|#anzeige|advertisement|pr[- ]?sample|gifted|zur verfügung gestellt|kindly sent|sent to me|pr[- ]paket)\b/i;
const AFFILIATE_RE = /(amzn\.to|link\.amazon|amazon\.[a-z.]+\/[^\s]*tag=|bit\.ly|coupon|discount code|rabattcode|gutscheincode|code:\s*[A-Z0-9]{4,}|\?ref=|affiliate|provisionslink|werbelink|\*\s*(=|affiliate|werbe))/i;

export function checkDisclosure(data) {
  const v = data.video || {};
  const title = v.title || "";
  const desc = v.description || "";
  const firstLines = desc.split("\n").slice(0, 3).join(" ");
  const findings = [];

  const titleHit = title.match(LABEL_RE);
  if (titleHit) findings.push({ source: "Title", strength: "strong", text: titleHit[0] });
  const descTop = firstLines.match(LABEL_RE);
  const descAny = desc.match(LABEL_RE);
  if (descTop) findings.push({ source: "Description (top)", strength: "strong", text: descTop[0] });
  else if (descAny) findings.push({ source: "Description (further down)", strength: "weak", text: descAny[0] });

  for (const d of data.disclosures || []) {
    const kind = (d.kind || "").toLowerCase();
    const early = d.time_s <= 30;
    const visual = /screen|text|label|overlay|visual|banner/.test(kind);
    findings.push({ source: visual ? "On-screen label" : "Spoken", time_s: d.time_s, text: d.text,
      strength: visual || early ? "strong" : "weak" });
  }

  const affiliate = desc.match(AFFILIATE_RE);
  const signals = [];
  if (data.paid?.looks_like_paid_promotion) signals.push("Gemini rates the video as paid or gifted promotion");
  if (affiliate) signals.push(`Shop / affiliate link in description ("${affiliate[0].slice(0, 32)}")`);
  if ((data.authenticity || []).length) signals.push("Products are actively recommended");

  const commercial = signals.length > 0 && (data.paid?.looks_like_paid_promotion || affiliate);
  let level = "none";
  if (commercial) {
    if (findings.some((f) => f.strength === "strong")) level = "green";
    else if (findings.length) level = "orange";
    else level = "red";
  }
  const text = {
    none: { title: "No advertising detected", sub: "No paid placement, gift or shop links found." },
    green: { title: "Disclosure found", sub: "Commercial content is labelled clearly." },
    orange: { title: "Check disclosure", sub: "A label exists, but it is weak – spoken later or hidden in the description." },
    red: { title: "No disclosure found", sub: "Commercial signals, but no advertising label in title, description, image or speech." },
  }[level];

  const checklist = [
    { label: "Title", ok: !!titleHit, detail: titleHit ? `"${titleHit[0]}"` : "no label" },
    { label: "Description", ok: !!descAny, detail: descAny ? `"${descAny[0]}"${descTop ? " (top)" : " (further down)"}` : "no label" },
    { label: "On-screen label", ok: findings.some((f) => f.source === "On-screen label"), detail: "" },
    { label: "Spoken", ok: findings.some((f) => f.source === "Spoken"), detail: "" },
  ];
  return { level, ...text, findings, signals, checklist, reasoning: data.paid?.reasoning || "" };
}
