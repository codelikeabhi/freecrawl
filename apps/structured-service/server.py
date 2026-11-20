"""fork: product and menu extraction (PLAN.md Phase 13, G15).

Speaks the API's clients (scraper/scrapeURL/transformers/product.ts, menu.ts):
  POST /v1/extract-product {html, url}        -> {"product": ProductProfile | null}
  POST /v1/scrape-menu     {html, url, title?} -> {"menu": MenuProfile | null}
Shapes: apps/api/src/types/product.ts, menu.ts. null = not a product/menu page.

Structured data first (JSON-LD), so prices and names are the site's own.
Pages without it go to the local model (Ollama) with a JSON schema; prices it
returns are kept only when they appear in the page text, menu items only when
their names do, so nothing is invented.
"""

import asyncio
import html as htmlmod
import json
import os
import re
import urllib.request
import uuid

from fastapi import FastAPI, Request

OLLAMA = os.environ.get("OLLAMA_BASE_URL", "http://host.docker.internal:11434/api").rstrip("/")
MODEL = os.environ.get("MODEL_NAME", "")
TEXT_LIMIT = 12000  # characters of page text sent to the model

app = FastAPI()

# ---------- page helpers ----------

LD_JSON = re.compile(r"<script[^>]+application/ld\+json[^>]*>(.*?)</script>", re.I | re.S)
DROP = re.compile(r"<(script|style|noscript|svg|template)\b.*?</\1>", re.I | re.S)
TAG = re.compile(r"<[^>]+>")
BLOCK = re.compile(r"</?(p|div|li|tr|h[1-6]|section|article|br|ul|ol|table)\b[^>]*>", re.I)


def page_text(html: str) -> str:
    text = BLOCK.sub("\n", DROP.sub(" ", html))
    text = htmlmod.unescape(TAG.sub(" ", text))
    return "\n".join(" ".join(line.split()) for line in text.splitlines() if line.strip())


def ld_nodes(html: str) -> list[dict]:
    nodes = []

    def walk(value):
        if isinstance(value, list):
            for v in value:
                walk(v)
        elif isinstance(value, dict):
            nodes.append(value)
            for key in ("@graph", "mainEntity", "itemListElement"):
                if key in value:
                    walk(value[key])

    for block in LD_JSON.findall(html):
        try:
            walk(json.loads(block.strip()))
        except ValueError:
            continue
    return nodes


def types(node: dict) -> set[str]:
    t = node.get("@type", [])
    return {x.split("/")[-1] for x in ([t] if isinstance(t, str) else t)}


def first(value):
    return value[0] if isinstance(value, list) and value else value


def text_of(value) -> str | None:
    value = first(value)
    if isinstance(value, dict):
        value = value.get("name") or value.get("@id")
    return str(value).strip() if value not in (None, "") else None


def number(value) -> float | None:
    try:
        return float(str(first(value)).replace(",", ""))
    except (TypeError, ValueError):
        return None


def price_obj(amount, currency) -> dict | None:
    amount = number(amount)
    if amount is None:
        return None
    out = {"amount": amount}
    if currency:
        out["currency"] = str(currency)
    return out


def in_text(amount: float, text: str) -> bool:
    """Is this price written on the page (49.99, 49,99, 1,299.00, 1299, 5)?"""
    whole, cents = f"{amount:.2f}".split(".")
    digits = f"{int(whole):,}".replace(",", "[,.]?")  # 1,299 / 1.299 / 1299
    tail = rf"(?:[.,]{cents})?" if cents == "00" else rf"[.,]{cents}"
    return re.search(rf"(?<![\d.,]){digits}{tail}(?!\d)", text) is not None


async def ask_model(prompt: str, schema: dict) -> dict | None:
    if not MODEL:
        return None
    body = json.dumps({"model": MODEL, "stream": False, "think": False, "format": schema,
                       "options": {"temperature": 0},
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(f"{OLLAMA}/chat", body, {"Content-Type": "application/json"})
    try:
        raw = await asyncio.to_thread(lambda: urllib.request.urlopen(req, timeout=45).read())
        return json.loads(json.loads(raw)["message"]["content"])
    except Exception:
        return None


# ---------- product ----------

CONDITIONS = {"NewCondition": "new", "UsedCondition": "used", "RefurbishedCondition": "refurbished",
              "DamagedCondition": "damaged"}
IN_STOCK = ("InStock", "LimitedAvailability", "OnlineOnly", "InStoreOnly", "PreOrder", "PreSale")


def offer_of(node: dict) -> dict:
    offer = first(node.get("offers")) or {}
    return offer if isinstance(offer, dict) else {}


def variant_of(node: dict, fallback_offer: dict | None = None) -> dict:
    offer = offer_of(node) or fallback_offer or {}
    amount = offer.get("price", offer.get("lowPrice"))
    variant: dict = {}
    for key in ("sku", "mpn"):
        if node.get(key):
            variant[key] = str(node[key])
    gtin = next((node[k] for k in ("gtin", "gtin13", "gtin12", "gtin14", "gtin8") if node.get(k)), None)
    if gtin:
        variant["gtin"] = str(gtin)
    condition = text_of(offer.get("itemCondition") or node.get("itemCondition"))
    if condition and condition.split("/")[-1] in CONDITIONS:
        variant["condition"] = CONDITIONS[condition.split("/")[-1]]
    if node.get("name"):
        variant["title"] = str(node["name"])
    price = price_obj(amount, offer.get("priceCurrency"))
    if price:
        variant["price"] = price
    availability = text_of(offer.get("availability")) or ""
    variant["availability"] = {"inStock": availability.split("/")[-1] in IN_STOCK if availability else price is not None}
    if availability:
        variant["availability"]["text"] = availability.split("/")[-1]
    images = [i for i in (node.get("image") if isinstance(node.get("image"), list) else [node.get("image")]) if i]
    urls = [i.get("url") if isinstance(i, dict) else i for i in images]
    if urls:
        variant["images"] = [{"url": str(u)} for u in urls if u]
    return variant


def product_from_ld(nodes: list[dict], url: str) -> dict | None:
    products = [n for n in nodes if types(n) & {"Product", "ProductGroup"}]
    if not products:
        return None
    node = next((n for n in products if "ProductGroup" in types(n)), products[0])
    variants = [variant_of(v, offer_of(node)) for v in node.get("hasVariant") or [] if isinstance(v, dict)]
    profile = {"title": str(node.get("name") or ""), "url": str(node.get("url") or url),
               "variants": variants or [variant_of(node)]}
    for key, value in (("brand", text_of(node.get("brand"))), ("category", text_of(node.get("category"))),
                       ("description", text_of(node.get("description")))):
        if value:
            profile[key] = value
    return profile if profile["title"] else None


PRODUCT_SCHEMA = {
    "type": "object",
    "properties": {
        "isProductPage": {"type": "boolean"}, "title": {"type": "string"}, "brand": {"type": "string"},
        "description": {"type": "string"}, "price": {"type": "number"}, "currency": {"type": "string"},
        "inStock": {"type": "boolean"}, "availabilityText": {"type": "string"},
    },
    "required": ["isProductPage", "title"],
}


@app.post("/v1/extract-product")
async def extract_product(request: Request):
    body = await request.json()
    html, url = body.get("html") or "", body.get("url") or ""
    found = product_from_ld(ld_nodes(html), url)
    if found:
        return {"product": found}
    text = page_text(html)
    answer = await ask_model(
        "Is this a page for ONE product that can be bought? If yes, extract it. Use only facts written "
        "in the page; leave fields out when the page does not say.\n\nURL: " + url + "\n\n" + text[:TEXT_LIMIT],
        PRODUCT_SCHEMA,
    )
    if not answer or not answer.get("isProductPage") or not answer.get("title"):
        return {"product": None}
    variant: dict = {"availability": {"inStock": bool(answer.get("inStock", True))}}
    if answer.get("availabilityText"):
        variant["availability"]["text"] = answer["availabilityText"]
    price = price_obj(answer.get("price"), answer.get("currency"))
    if price and in_text(price["amount"], text):  # never a price the page does not show
        variant["price"] = price
    profile = {"title": answer["title"], "url": url, "variants": [variant]}
    for key in ("brand", "description"):
        if answer.get(key):
            profile[key] = answer[key]
    return {"product": profile}


# ---------- menu ----------

def menu_item(node: dict, page: str) -> dict:
    offer = offer_of(node)
    item = {"id": str(node.get("@id") or uuid.uuid4()), "name": str(node.get("name") or ""),
            "images": [], "availability": {"inStock": True}, "dietary": [], "optionGroups": [],
            "identifiers": {}, "sourceUrl": page}
    if node.get("description"):
        item["description"] = str(node["description"])
    price = price_obj(offer.get("price"), offer.get("priceCurrency"))
    if price:
        item["price"] = price
    diets = node.get("suitableForDiet") or []
    item["dietary"] = [str(d).split("/")[-1].removesuffix("Diet") for d in (diets if isinstance(diets, list) else [diets])]
    calories = number(re.sub(r"[^\d.]", "", str((node.get("nutrition") or {}).get("calories") or "")) or None)
    if calories is not None:
        item["calories"] = calories
    return item


def menu_from_ld(nodes: list[dict], url: str, title: str | None) -> dict | None:
    merchant = next((n for n in nodes if types(n) & {"Restaurant", "FoodEstablishment", "CafeOrCoffeeShop",
                                                     "Bakery", "BarOrPub", "FastFoodRestaurant"}), None)
    menus = [n for n in nodes if "Menu" in types(n)]
    if merchant and isinstance(merchant.get("hasMenu"), dict):
        menus.insert(0, merchant["hasMenu"])
    sections = []
    for menu in menus:
        for sec in menu.get("hasMenuSection") or []:
            if isinstance(sec, dict):
                items = [menu_item(i, url) for i in sec.get("hasMenuItem") or [] if isinstance(i, dict)]
                if items:
                    sections.append({"id": str(sec.get("@id") or uuid.uuid4()), "name": str(sec.get("name") or "Menu"),
                                     **({"description": str(sec["description"])} if sec.get("description") else {}),
                                     "items": items})
        loose = [menu_item(i, url) for i in menu.get("hasMenuItem") or [] if isinstance(i, dict)]
        if loose:
            sections.append({"id": str(uuid.uuid4()), "name": str(menu.get("name") or "Menu"), "items": loose})
    if not sections:
        return None
    currency = next((i["price"].get("currency") for s in sections for i in s["items"] if i.get("price")), None)
    return {"isMenu": True, "confidence": 0.95,
            "merchant": {"name": str((merchant or {}).get("name") or title or ""),
                         "type": next(iter(types(merchant)), None) if merchant else None},
            "currency": currency, "sections": sections, "sourceUrl": url}


MENU_SCHEMA = {
    "type": "object",
    "properties": {
        "isMenuPage": {"type": "boolean"}, "merchantName": {"type": "string"}, "currency": {"type": "string"},
        "sections": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"},
            "items": {"type": "array", "items": {"type": "object", "properties": {
                "name": {"type": "string"}, "description": {"type": "string"}, "price": {"type": "number"},
            }, "required": ["name"]}},
        }, "required": ["name", "items"]}},
    },
    "required": ["isMenuPage"],
}


@app.post("/v1/scrape-menu")
async def scrape_menu(request: Request):
    body = await request.json()
    html, url, title = body.get("html") or "", body.get("url") or "", body.get("title")
    found = menu_from_ld(ld_nodes(html), url, title)
    if found:
        return {"menu": found}
    text = page_text(html)
    answer = await ask_model(
        "Is this a restaurant or cafe menu page (dishes or drinks with prices)? If yes, extract the "
        "sections and items exactly as written; do not invent items or prices.\n\nURL: " + url + "\n\n"
        + text[:TEXT_LIMIT],
        MENU_SCHEMA,
    )
    if not answer or not answer.get("isMenuPage"):
        return {"menu": None}
    lower = text.lower()
    sections = []
    for sec in answer.get("sections") or []:
        items = []
        for raw in sec.get("items") or []:
            name = (raw.get("name") or "").strip()
            if not name or name.lower() not in lower:  # never an item the page does not list
                continue
            item = {"id": str(uuid.uuid4()), "name": name, "images": [], "availability": {"inStock": True},
                    "dietary": [], "optionGroups": [], "identifiers": {}, "sourceUrl": url}
            if raw.get("description"):
                item["description"] = raw["description"]
            price = price_obj(raw.get("price"), answer.get("currency"))
            if price and in_text(price["amount"], text):
                item["price"] = price
            items.append(item)
        if items:
            sections.append({"id": str(uuid.uuid4()), "name": sec.get("name") or "Menu", "items": items})
    if not sections:
        return {"menu": None}
    return {"menu": {"isMenu": True, "confidence": 0.6,
                     "merchant": {"name": answer.get("merchantName") or title or "", "type": None},
                     "currency": answer.get("currency"), "sections": sections, "sourceUrl": url}}


@app.get("/health")
def health():
    return {"status": "healthy", "model": MODEL or None}
