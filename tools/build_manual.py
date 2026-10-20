#!/usr/bin/env python3
"""Build offline HTML and printable PDF operator or user guides from checked-in JSON.

The HTML builder uses only Python's standard library. PDF output additionally
requires ReportLab and DejaVu fonts (fonts-dejavu-core on Ubuntu/Debian).
"""
import argparse
import base64
import html
import json
from pathlib import Path
import re


TITLE = "Hydra Signal Lab instruction manual"
SUBTITLE = "Linux setup and operation with Keirzo and Hydrasynth"
EDITION = "Linux edition | 20 October 2026"
INTRO = (
    "Start with browser sound and bundled recordings, then add generated music, "
    "MIDI instruments and robot performance as needed. This manual covers first "
    "installation, daily use, six-laptop provisioning, study collection and recovery."
)
SCOPE = (
    "Screenshots show the actual local application with the robot and Hydrasynth "
    "disconnected. Empty results and disabled hardware controls are intentional. "
    "Physical procedures are based on the current controls and implementation; "
    "they have not been demonstrated on a connected Linux rig for this edition. "
    "No paid generation was performed to create the screenshots."
)


GUIDES = {
    "operator": {
        "title": TITLE, "subtitle": SUBTITLE, "edition": EDITION,
        "intro": INTRO, "scope": SCOPE, "label": "Instruction manual",
        "kicker": "Operator guide", "stem": "instruction-manual",
        "source": "manual-content.json", "footer": "Linux edition  |  20 October 2026",
    },
    "user": {
        "title": "Hydra Signal Lab user guide",
        "subtitle": "Start playing on your prepared laptop",
        "edition": "Prepared laptop edition | 20 October 2026",
        "intro": "Make sound from movement, shape music and create spoken or rapped replies. Start with the first five minutes, then explore one workspace at a time.",
        "scope": "Your laptop is already set up. Use the browser and starting setup supplied by your organiser. The optional robot chapter is for a connected rig that you have been shown how to operate.",
        "label": "User guide", "kicker": "Ready to play", "stem": "user-guide",
        "source": "user-guide-content.json", "footer": "Prepared laptop edition  |  20 October 2026",
    },
}


def plain(value):
    return str(value).translate(str.maketrans({
        "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-",
        "\u2014": " - ", "\u2212": "-", "\u00a0": " ", "→": " > ",
        "↗": "", "▶": "", "■": "", "…": "...",
    }))


def escaped(value):
    return html.escape(plain(value))


def picture_path(block, assets):
    path = assets / Path(block["src"]).name
    if not path.is_file():
        raise ValueError(f"Missing screenshot: {path}")
    return path


def data_image(path):
    return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


CSS = """
:root{--ink:#172331;--muted:#526176;--blue:#175799;--line:#d7e0ea;--paper:#fff;--wash:#edf3f8}
*{box-sizing:border-box}html{scroll-behavior:auto}body{margin:0;color:var(--ink);background:var(--wash);font:16px/1.65 system-ui,-apple-system,Segoe UI,sans-serif}
a{color:var(--blue);text-underline-offset:3px}aside{position:fixed;inset:0 auto 0 0;width:282px;overflow:auto;padding:28px 22px;background:#132334;color:#fff;font-size:13px;line-height:1.45}
aside a{display:block;color:#dce9f6;text-decoration:none;padding:7px 0;border-bottom:1px solid #ffffff16}aside a:hover,aside a:focus{color:white;text-decoration:underline}aside strong{font-size:19px;display:block;margin-bottom:10px}aside p{color:#bed0e0;font-size:12px}
main{margin:0 0 0 282px;padding:40px 5vw 90px;max-width:1350px}.cover,section{background:var(--paper);padding:42px 48px;margin-bottom:24px;border:1px solid var(--line);border-radius:8px}
h1,h2,h3{color:#12283c;line-height:1.2;letter-spacing:-.025em}h1{font-size:40px;margin:12px 0 16px}h2{font-size:28px;margin:0 0 24px}h3{font-size:21px;margin:32px 0 14px}.kicker{text-transform:uppercase;letter-spacing:.12em;font-size:11px;font-weight:750;color:var(--blue)}.subtitle{font-size:21px;line-height:1.4;color:var(--muted)}.lede{font-size:18px}
p{margin:0 0 16px}li{padding-left:4px;margin:0 0 10px}ol,ul{padding-left:25px;margin:12px 0 22px}.note{border-left:4px solid #3984ba;background:#eef5fa;padding:18px 22px;margin:22px 0;color:#203e55;border-radius:0 5px 5px 0}.note p:last-child{margin:0}
pre{overflow:auto;background:#142435;color:#f1f6fa;border-radius:6px;padding:20px;font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;margin:18px 0 26px;font-size:14px;line-height:1.5}th{background:#e9f0f7;color:#173c60;text-align:left;font-weight:700}th,td{padding:12px 14px;vertical-align:top;border:1px solid var(--line)}tr:nth-child(even) td{background:#f8fafc}
figure{margin:26px 0}figure img{max-width:100%;width:auto;display:block;height:auto;border:1px solid #c8d2df;border-radius:5px}figcaption{font-size:13px;line-height:1.5;color:var(--muted);margin-top:10px}.actions{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}.actions a,.actions button{font:inherit;font-size:14px;padding:9px 16px;background:#175799;color:#fff;border:0;border-radius:5px;text-decoration:none;cursor:pointer}.meta{color:var(--muted);font-size:13px}.chapter-num{display:block;color:#35729f;font-size:12px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:12px}.back{font-size:12px;margin-top:28px}.cover img{margin-top:20px;width:100%;border-radius:6px}.toc-mobile{display:none}
@media(max-width:1000px){aside{width:235px;padding:20px 16px}main{margin-left:235px;padding:24px}.cover,section{padding:30px}h1{font-size:34px}}
@media(max-width:760px){aside{display:none}main{margin:0;padding:14px}.cover,section{padding:24px 20px}h1{font-size:30px}h2{font-size:25px}table{font-size:12px}th,td{padding:8px}pre{font-size:12px}.toc-mobile{display:block}.toc-mobile a{display:block;margin:9px 0}}
@media print{aside,.actions,.back,.toc-mobile{display:none}body{background:white;font-size:10pt}main{margin:0;padding:0;max-width:none}.cover,section{border:0;padding:0;margin:0 0 20pt;break-before:page}.cover{break-before:auto}h1{font-size:28pt}h2{font-size:22pt}h3{break-after:avoid}p,li{orphans:3;widows:3}figure{break-inside:avoid}pre{color:black;background:#f3f5f7;font-size:8pt}table{font-size:8pt}tr{break-inside:avoid}a{color:#175799}@page{size:A4;margin:18mm}}
"""


def build_html(sections, out, assets, audience="operator"):
    guide = GUIDES[audience]
    title, subtitle, edition, intro, scope = (guide[key] for key in ("title", "subtitle", "edition", "intro", "scope"))
    label, kicker, pdf_name = guide["label"], guide["kicker"], guide["stem"] + ".pdf"
    dashboard_link = '<a href="http://127.0.0.1:8790/#synth-mixer" target="_blank" rel="noopener">Open dashboard</a>' if audience == "user" else ""
    toc = "".join(f'<a href="#{s["id"]}">{i}. {escaped(s["title"])}</a>' for i, s in enumerate(sections, 1))
    parts = [f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>{CSS}</style></head><body>']
    parts += [f'<aside aria-label="Table of contents"><strong>Hydra Signal Lab</strong><p>{label}<br>{edition}</p>{toc}<p>Use Ctrl+F or Cmd+F to search the complete manual.</p></aside><main id="top">']
    parts += [f'<header class="cover"><div class="kicker">{kicker}</div><h1>{title}</h1><p class="subtitle">{subtitle}</p><p class="meta">{edition}</p><p class="lede">{intro}</p><div class="actions">{dashboard_link}<a href="#quick-start">Begin with the quick start</a><a href="{pdf_name}">Printable PDF</a><button onclick="window.print()">Print this page</button></div><div class="note">{scope}</div><img src="{data_image(assets / "synth-mixer.jpg")}" alt="Actual Synth mixer workspace in browser audio mode"><details class="toc-mobile"><summary>Contents</summary>{toc}</details></header>']
    figure_number = 0
    for index, section in enumerate(sections, 1):
        parts.append(f'<section id="{section["id"]}"><span class="chapter-num">Chapter {index:02d}</span><h2>{escaped(section["title"])}</h2>')
        for b in section["blocks"]:
            kind = b["type"]
            if kind == "p": parts.append(f'<p>{escaped(b["text"])}</p>')
            elif kind == "h2": parts.append(f'<h3>{escaped(b["text"])}</h3>')
            elif kind == "note": parts.append(f'<div class="note">{escaped(b["text"])}</div>')
            elif kind == "code": parts.append(f'<pre><code>{html.escape(b["text"])}</code></pre>')
            elif kind in ("ol", "ul"):
                parts.append(f'<{kind}>' + "".join(f'<li>{escaped(x)}</li>' for x in b["items"]) + f'</{kind}>')
            elif kind == "table":
                parts.append('<table><thead><tr>' + "".join(f'<th scope="col">{escaped(x)}</th>' for x in b["headers"]) + '</tr></thead><tbody>')
                parts.extend('<tr>' + "".join(f'<td>{escaped(x)}</td>' for x in row) + '</tr>' for row in b["rows"])
                parts.append('</tbody></table>')
            elif kind == "figure":
                figure_number += 1
                parts.append(f'<figure><img src="{data_image(picture_path(b, assets))}" alt="{escaped(b["caption"])}"><figcaption>Figure {figure_number}. {escaped(b["caption"])}</figcaption></figure>')
            else: raise ValueError(f"Unsupported block type: {kind}")
        parts.append('<p class="back"><a href="#top">Back to contents</a></p></section>')
    parts.append('</main></body></html>')
    out.write_text("\n".join(parts), encoding="utf-8")


def build_pdf(sections, out, assets, font_directory, audience="operator"):
    guide = GUIDES[audience]
    title, subtitle, edition, intro, scope = (guide[key] for key in ("title", "subtitle", "edition", "intro", "scope"))
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import (BaseDocTemplate, CondPageBreak, Frame, Image, KeepTogether,
        ListFlowable, ListItem, PageBreak, PageTemplate, Paragraph, Preformatted,
        Spacer, Table, TableStyle)
    from reportlab.platypus.tableofcontents import TableOfContents

    directory = Path(font_directory)
    for name, file in [("Body", "DejaVuSans.ttf"), ("Strong", "DejaVuSans-Bold.ttf"), ("Mono", "DejaVuSansMono.ttf")]:
        pdfmetrics.registerFont(TTFont(name, str(directory / file)))
    pdfmetrics.registerFontFamily("Body", normal="Body", bold="Strong", italic="Body", boldItalic="Strong")
    ink, muted, blue, line = [colors.HexColor(x) for x in ("#172331", "#526176", "#175799", "#d7e0ea")]
    width, height = A4
    margin = 43
    usable = width - 2 * margin
    styles = {
        "body": ParagraphStyle("BodyText", fontName="Body", fontSize=(11 if audience == "user" else 10.1), leading=(16 if audience == "user" else 14.7), textColor=ink, spaceAfter=8, allowWidows=0, allowOrphans=0),
        "h1": ParagraphStyle("Chapter", fontName="Strong", fontSize=21, leading=26, textColor=ink, spaceBefore=6, spaceAfter=18, keepWithNext=True),
        "h2": ParagraphStyle("Subheading", fontName="Strong", fontSize=13, leading=17, textColor=blue, spaceBefore=15, spaceAfter=8, keepWithNext=True),
        "title": ParagraphStyle("CoverTitle", fontName="Strong", fontSize=29, leading=35, textColor=ink, spaceAfter=18),
        "subtitle": ParagraphStyle("Subtitle", fontName="Body", fontSize=15, leading=21, textColor=muted, spaceAfter=16),
        "label": ParagraphStyle("Label", fontName="Strong", fontSize=9, leading=13, textColor=blue, spaceAfter=9, keepWithNext=True),
        "small": ParagraphStyle("Small", fontName="Body", fontSize=8.5, leading=12, textColor=muted, spaceAfter=9),
        "cell": ParagraphStyle("Cell", fontName="Body", fontSize=(9.3 if audience == "user" else 8.6), leading=(13.5 if audience == "user" else 12.3), textColor=ink, spaceAfter=0),
        "head": ParagraphStyle("TableHead", fontName="Strong", fontSize=(9.3 if audience == "user" else 8.6), leading=(13.5 if audience == "user" else 12.3), textColor=blue, spaceAfter=0),
        "note": ParagraphStyle("Note", fontName="Body", fontSize=9.3, leading=13.5, textColor=ink, borderColor=line, borderWidth=0.5, borderPadding=10, backColor=colors.HexColor("#eef5fa"), spaceBefore=12, spaceAfter=15),
        "code": ParagraphStyle("Code", fontName="Mono", fontSize=7.4, leading=10.7, textColor=ink, borderPadding=9, backColor=colors.HexColor("#f0f3f6"), spaceBefore=8, spaceAfter=14),
    }

    def para(text, style="body"):
        value = escaped(text)
        # Make literal URLs clickable without interpreting arbitrary markup.
        def url_link(match):
            url = match[0].rstrip(".,);")
            return f'<link color="#175799" href="{url}">{url}</link>' + match[0][len(url):]
        value = re.sub(r'https?://[^\s<]+', url_link, value)
        return Paragraph(value, styles[style])

    def picture(path, max_height=300):
        iw, ih = ImageReader(str(path)).getSize()
        scale = min(usable / iw, max_height / ih)
        return Image(str(path), width=iw * scale, height=ih * scale, hAlign="LEFT")

    class ManualDoc(BaseDocTemplate):
        def __init__(self):
            super().__init__(str(out), pagesize=A4, leftMargin=margin, rightMargin=margin,
                             topMargin=49, bottomMargin=46, title=title, author="Hydra Signal Lab", pageCompression=1)
            self.addPageTemplates(PageTemplate(id="normal", frames=[Frame(margin, 46, usable, height - 95, leftPadding=0, bottomPadding=0, rightPadding=0, topPadding=0)], onPage=self.page_decorations))

        def page_decorations(self, canvas, doc):
            canvas.saveState()
            if doc.page > 1:
                canvas.setFont("Body", 8)
                canvas.setFillColor(muted)
                canvas.drawString(margin, height - 29, "HYDRA SIGNAL LAB  /  " + guide["label"].upper())
                canvas.setStrokeColor(line)
                canvas.line(margin, 34, width - margin, 34)
                canvas.drawString(margin, 22, guide["footer"])
                canvas.drawRightString(width - margin, 22, str(doc.page))
            canvas.restoreState()

        def afterFlowable(self, flowable):
            if hasattr(flowable, "manual_key"):
                key, text = flowable.manual_key, flowable.getPlainText()
                self.canv.bookmarkPage(key)
                self.canv.addOutlineEntry(text, key, 0, False)
                self.notify("TOCEntry", (0, text, self.page, key))

    story = [Spacer(1, 24), para(guide["kicker"].upper(), "label"), para(title, "title"), para(subtitle, "subtitle"), para(edition, "small"), Spacer(1, 10), para(intro), picture(assets / "synth-mixer.jpg", 285), Spacer(1, 14), para(scope, "note"), para("Quick start first. Detailed procedures follow. Use the linked contents or PDF bookmarks to jump to a chapter.", "small"), PageBreak()]
    story += [para("Contents", "h1")]
    toc = TableOfContents()
    toc.levelStyles = [ParagraphStyle("TOC", fontName="Body", fontSize=9.5, leading=14, textColor=ink, leftIndent=0, firstLineIndent=0, spaceBefore=4, rightIndent=22)]
    story += [toc, PageBreak()]
    figure = 0
    for index, section in enumerate(sections, 1):
        if index > 1:
            if ((audience == "user" and section["id"] in {"opening", "using-keirzo", "help"})
                    or (audience == "operator" and section["id"] in {"connections", "robot-connections", "study-recording", "troubleshooting", "reference"})):
                story.append(PageBreak())
            else:
                minimum = 560 if audience == "user" and any(b["type"] == "figure" for b in section["blocks"][:3]) else 300
                story.extend([CondPageBreak(minimum), Spacer(1, 25)])
        story.append(para(f"CHAPTER {index:02d}", "label"))
        heading = para(section["title"], "h1")
        heading.manual_key = section["id"]
        story.append(heading)
        for block_index, b in enumerate(section["blocks"]):
            kind = b["type"]
            if kind in ("p", "h2", "note"):
                if kind == "h2":
                    next_block = section["blocks"][block_index + 1] if block_index + 1 < len(section["blocks"]) else None
                    minimum = 100
                    if audience == "user" and next_block and next_block["type"] == "figure":
                        minimum = 430
                    if audience == "user" and b["text"] == "Choose your next exercise":
                        minimum = 300
                    story.append(CondPageBreak(minimum))
                paragraph = para(b["text"], "body" if kind == "p" else kind)
                story.append(KeepTogether([paragraph]) if audience == "user" and kind == "note" else paragraph)
            elif kind in ("ol", "ul"):
                story.append(ListFlowable([ListItem(para(x), leftIndent=12, value=(i + 1 if kind == "ol" else None)) for i, x in enumerate(b["items"])], bulletType="1" if kind == "ol" else "bullet", start="1" if kind == "ol" else "circle", leftIndent=17, bulletFontName="Body", bulletFontSize=9, spaceAfter=8))
            elif kind == "code":
                lines = plain(b["text"])
                if any(len(x) > 102 for x in lines.splitlines()):
                    raise ValueError("Split long code into valid shell continuations in the source")
                story.append(Preformatted(lines, styles["code"]))
            elif kind == "table":
                cols = len(b["headers"])
                fractions = [0.32, 0.68] if cols == 2 else [1 / cols] * cols
                if cols == 2 and b["headers"][0] == "Command":
                    fractions = [0.48, 0.52]
                data = [[para(x, "head") for x in b["headers"]]] + [[para(x, "cell") for x in row] for row in b["rows"]]
                table = Table(data, colWidths=[usable * f for f in fractions], repeatRows=1, hAlign="LEFT", spaceBefore=6, spaceAfter=14)
                table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e9f0f7")), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]), ("BOX", (0, 0), (-1, -1), .4, line), ("INNERGRID", (0, 0), (-1, -1), .4, line), ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
                story.append(table)
            elif kind == "figure":
                figure += 1
                image_height = {"session-library.jpg": 400, "study-panel.jpg": 350}.get(Path(b["src"]).name, 300)
                story.append(KeepTogether([Spacer(1, 8), picture(picture_path(b, assets), image_height), Spacer(1, 7), para(f"Figure {figure}. {b['caption']}", "small"), Spacer(1, 10)]))
    ManualDoc().multiBuild(story)


def main():
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audience", choices=GUIDES, default="operator", help="Build the full operator manual or the prepared-laptop user guide")
    parser.add_argument("--source", type=Path, help="Override the audience-specific content JSON")
    parser.add_argument("--assets", type=Path, default=repo / "docs/manual-assets")
    parser.add_argument("--output-dir", type=Path, default=repo / "docs")
    parser.add_argument("--html-only", action="store_true")
    parser.add_argument("--font-dir", default="/usr/share/fonts/truetype/dejavu")
    args = parser.parse_args()
    guide = GUIDES[args.audience]
    source = args.source or repo / "docs" / guide["source"]
    sections = json.loads(source.read_text(encoding="utf-8"))
    assert len({s["id"] for s in sections}) == len(sections), "Duplicate section IDs"
    args.output_dir.mkdir(parents=True, exist_ok=True)
    build_html(sections, args.output_dir / (guide["stem"] + ".html"), args.assets, args.audience)
    if not args.html_only:
        build_pdf(sections, args.output_dir / (guide["stem"] + ".pdf"), args.assets, args.font_dir, args.audience)
    print(f"Built {len(sections)} chapters in {args.output_dir}")


if __name__ == "__main__":
    main()
