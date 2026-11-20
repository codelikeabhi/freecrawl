#!/usr/bin/env bash
# Gap matrix: exercise every user-facing v2 feature against the local API and report
# whether real output came back (not just success:true). Re-run after each phase.
#
#   scripts/fork/gap-matrix.sh            run all cases
#   scripts/fork/gap-matrix.sh 'search'   only cases whose name matches the regex
#
# OK   = the feature's output is present      FAIL = request failed or output missing
# Raw responses are kept in $OUT (printed at the end).
set -uo pipefail

API="${FIRECRAWL_API_URL:-http://localhost:3002}"
OUT="${OUT:-$(mktemp -d -t gap-matrix)}"
FILTER="${1:-.}"

HTML=https://example.com
JS=https://quotes.toscrape.com/js/          # quotes rendered by JavaScript
PDF=https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf
DOCX=https://calibre-ebook.com/downloads/demos/demo.docx
YT="https://www.youtube.com/watch?v=jNQXAC9IVRw"   # "Me at the zoo", 19 s
NOSITEMAP=https://books.toscrape.com/
CF1=https://nowsecure.nl                        # Cloudflare challenge test page
CF2=https://www.crunchbase.com

# name ;; method path ;; JSON body ;; jq evidence (true = feature output present)
# Paths starting with "async " are polled at GET <path>/<id> until done (max 120 s).
# Paths starting with "get " are GET requests; the body column is the query string.
CASES=$(cat <<EOF
scrape.markdown ;; /v2/scrape ;; {"url":"$HTML"} ;; (.data.markdown|length)>0
scrape.html+raw+links+images ;; /v2/scrape ;; {"url":"$HTML","formats":["html","rawHtml","links","images"]} ;; (.data.html|length)>0 and (.data.rawHtml|length)>0 and (.data.links|length)>0
scrape.js-rendered ;; /v2/scrape ;; {"url":"$JS"} ;; .data.markdown|test("Einstein")
scrape.waitFor ;; /v2/scrape ;; {"url":"$JS","waitFor":2000} ;; .data.markdown|test("Einstein")
scrape.mobile ;; /v2/scrape ;; {"url":"$HTML","mobile":true} ;; (.data.markdown|length)>0 and .data.warning == null
scrape.location ;; /v2/scrape ;; {"url":"$HTML","location":{"country":"DE"}} ;; (.data.markdown|length)>0 and ((.data.warning // "") | test("IP address"))
scrape.blockAds-off ;; /v2/scrape ;; {"url":"$HTML","blockAds":false} ;; (.data.markdown|length)>0 and .data.warning == null
scrape.redactPII ;; /v2/scrape ;; {"url":"$HTML","redactPII":true} ;; (.data.markdown|length)>0
scrape.profile ;; /v2/scrape ;; {"url":"$HTML","profile":{"name":"fork-test"}} ;; (.data.markdown|length)>0
scrape.lockdown ;; /v2/scrape ;; {"url":"$HTML","lockdown":true} ;; (.data.markdown|length)>0
format.screenshot ;; /v2/scrape ;; {"url":"$HTML","formats":["screenshot"]} ;; .data.screenshot != null
format.screenshot-fullPage ;; /v2/scrape ;; {"url":"$HTML","formats":[{"type":"screenshot","fullPage":true}]} ;; .data.screenshot != null
format.rawBase64 ;; /v2/scrape ;; {"url":"$PDF","formats":["rawBase64"]} ;; .data.rawBase64 != null
format.attributes ;; /v2/scrape ;; {"url":"$HTML","formats":[{"type":"attributes","selectors":[{"selector":"a","attribute":"href"}]}]} ;; (.data.attributes|length)>0
format.summary ;; /v2/scrape ;; {"url":"$HTML","formats":["summary"]} ;; .data.summary != null
format.json-schema ;; /v2/scrape ;; {"url":"$HTML","formats":[{"type":"json","schema":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}}]} ;; .data.json.title != null
format.json-prompt ;; /v2/scrape ;; {"url":"$HTML","formats":[{"type":"json","prompt":"Extract the page title"}]} ;; .data.json != null
format.question ;; /v2/scrape ;; {"url":"$HTML","formats":[{"type":"question","question":"What is this domain for?"}]} ;; .data.answer != null
format.highlights ;; /v2/scrape ;; {"url":"$HTML","formats":[{"type":"highlights","query":"documentation examples"}]} ;; .data.highlights != null
format.onlyCleanContent ;; /v2/scrape ;; {"url":"$HTML","onlyCleanContent":true} ;; (.data.markdown|length)>0 and .success == true
format.checkPromptInjection ;; /v2/scrape ;; {"url":"$HTML","checkPromptInjection":true} ;; .success == true and ((.data.warning // "") | test("could not scan") | not)
crawl.prompt-preview ;; /v2/crawl/params-preview ;; {"url":"$NOSITEMAP","prompt":"Only crawl the poetry category, at most 10 pages"} ;; .success == true and (.data | tostring | test("poetry";"i"))
format.changeTracking ;; /v2/scrape ;; {"url":"$HTML","formats":["markdown",{"type":"changeTracking","modes":["git-diff"]}]} ;; .data.changeTracking != null
format.branding ;; /v2/scrape ;; {"url":"$HTML","formats":["branding"]} ;; .data.branding != null
format.product ;; /v2/scrape ;; {"url":"https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html","formats":["product"]} ;; .data.product != null
format.menu ;; /v2/scrape ;; {"url":"$HTML","formats":["menu"]} ;; .data.menu != null
format.audio ;; /v2/scrape ;; {"url":"$YT","formats":["audio"]} ;; .data.audio != null
format.video ;; /v2/scrape ;; {"url":"$YT","formats":["video"]} ;; .data.video != null
actions.click-wait-scrape ;; /v2/scrape ;; {"url":"$JS","actions":[{"type":"wait","milliseconds":500},{"type":"click","selector":"li.next a"},{"type":"wait","milliseconds":500},{"type":"scrape"}]} ;; (.data.actions.scrapes|length)>0
actions.screenshot ;; /v2/scrape ;; {"url":"$HTML","actions":[{"type":"screenshot"}]} ;; (.data.actions.screenshots|length)>0
actions.executeJavascript ;; /v2/scrape ;; {"url":"$HTML","actions":[{"type":"executeJavascript","script":"return document.title"}]} ;; (.data.actions.javascriptReturns|length)>0
actions.pdf ;; /v2/scrape ;; {"url":"$HTML","actions":[{"type":"pdf"}]} ;; (.data.actions.pdfs|length)>0
file.pdf ;; /v2/scrape ;; {"url":"$PDF"} ;; .data.markdown|test("Dummy")
file.docx ;; /v2/scrape ;; {"url":"$DOCX"} ;; (.data.markdown|length)>100
youtube.page ;; /v2/scrape ;; {"url":"$YT"} ;; (.data.markdown|length)>200
protected.nowsecure ;; /v2/scrape ;; {"url":"$CF1"} ;; .data.metadata.statusCode == 200 and (.data.markdown|test("Just a moment|challenge|Verifying";"i")|not)
protected.crunchbase ;; /v2/scrape ;; {"url":"$CF2"} ;; .data.metadata.statusCode == 200 and (.data.markdown|test("Just a moment|challenge|Verifying";"i")|not)
proxy.stealth ;; /v2/scrape ;; {"url":"$HTML","proxy":"stealth"} ;; .data.metadata.proxyUsed == "stealth"
proxy.enhanced ;; /v2/scrape ;; {"url":"$HTML","proxy":"enhanced"} ;; .data.metadata.proxyUsed == "stealth"
search.basic ;; /v2/search ;; {"query":"firecrawl web scraping","limit":5} ;; (.data.web|length)>0
search.scrape-results ;; /v2/search ;; {"query":"firecrawl web scraping","limit":3,"scrapeOptions":{"formats":["markdown"]}} ;; (.data.web[0].markdown|length)>0
search.tbs ;; /v2/search ;; {"query":"firecrawl release","limit":5,"tbs":"qdr:m"} ;; (.data.web|length)>0
search.news ;; /v2/search ;; {"query":"web scraping","limit":5,"sources":["news"]} ;; (.data.news|length)>0
search.images ;; /v2/search ;; {"query":"web scraping","limit":5,"sources":["images"]} ;; (.data.images|length)>0
search.developer ;; /v2/search ;; {"query":"playwright click selector timeout","limit":5,"categories":["developer"]} ;; (.data.web|length)>0
search.research ;; /v2/search ;; {"query":"transformer attention","limit":5,"categories":["research"]} ;; (.data.web|length)>0
search.location ;; /v2/search ;; {"query":"weather","limit":5,"location":"Germany"} ;; (.data.web|length)>0
search.gov ;; /v2/search ;; {"query":"food labeling requirements","limit":5,"categories":["gov"]} ;; (.data.web|length)>0
index.papers ;; get /v2/search/research/papers ;; query=attention%20is%20all%20you%20need&k=2 ;; (.results|length)>0
index.paper-read ;; get /v2/search/research/papers/1706.03762 ;; query=multi-head%20attention&k=2 ;; (.passages|length)>0
index.similar ;; get /v2/search/research/papers/1706.03762/similar ;; intent=efficient%20transformers&k=3 ;; (.results|length)>0
index.protein ;; get /v2/search/research/proteins ;; protein=TP53 ;; .match == "found"
index.developer ;; /v2/search/developer ;; {"query":"graceful shutdown","k":3} ;; (.results|length)>0
index.gov ;; /v2/search/gov ;; {"query":"food labeling requirements","k":3,"sources":["web","gov"]} ;; (.data.gov|length)>0
map.sitemap ;; /v2/map ;; {"url":"https://docs.firecrawl.dev","limit":20} ;; (.links|length)>0
map.no-sitemap ;; /v2/map ;; {"url":"$NOSITEMAP","limit":20} ;; (.links|length)>0
map.search-param ;; /v2/map ;; {"url":"https://docs.firecrawl.dev","search":"crawl","limit":10} ;; (.links|length)>0
batch.scrape ;; async /v2/batch/scrape ;; {"urls":["$HTML","$JS"]} ;; .status == "completed" and (.data|length) == 2
crawl.screenshot ;; async /v2/crawl ;; {"url":"$NOSITEMAP","limit":2,"scrapeOptions":{"formats":["screenshot"]}} ;; .status == "completed" and (.data[0].screenshot != null)
agent ;; async /v2/agent ;; {"prompt":"Find the title of example.com"} ;; .status == "completed"
monitor.create ;; /v2/monitor ;; {"name":"gap-matrix","schedule":{"text":"hourly"},"targets":[{"type":"scrape","urls":["$HTML"]}]} ;; .success == true and .data.id != null
computer.session ;; /v2/computer/sessions ;; {} ;; .success == true
alexandria ;; /v2/alexandria ;; {"provider":"fred","capability":"series/observations","options":{}} ;; .success == true
scrape.by-id ;; get /v2/scrape/{SCRAPE_ID} ;;  ;; (.data.markdown|length)>0
interact ;; /v2/scrape/{SCRAPE_ID}/interact ;; {"prompt":"What is the page title?"} ;; .success == true
EOF
)

note() { jq -r '[.error, .code, .warning, .data.warning, .data.metadata.error] | map(select(. != null and . != "")) | join(" | ")' 2>/dev/null <<<"$1" | tr '\n' ' ' | cut -c1-170; }
field() { local s=$1; printf '%s' "${s%% ;; *}"; }

printf '%-30s %-4s %-4s %s\n' CASE HTTP RES NOTE
scrape_id=""
while IFS= read -r line; do
  name=$(field "$line"); line=${line#* ;; }
  path=$(field "$line"); line=${line#* ;; }
  body=$(field "$line"); evidence=${line#* ;; }
  [[ $name =~ $FILTER ]] || continue

  async=0 get=0
  [[ $path == async\ * ]] && async=1 && path=${path#async }
  [[ $path == get\ * ]] && get=1 && path=${path#get }
  path=${path//\{SCRAPE_ID\}/${scrape_id:-none}}

  if [[ $get == 1 ]]; then
    resp=$(curl -sS --max-time 150 -w $'\n%{http_code}' "$API$path?$body" 2>&1)
  else
    resp=$(curl -sS --max-time 150 -w $'\n%{http_code}' -X POST "$API$path" \
      -H 'Content-Type: application/json' -d "$body" 2>&1)
  fi
  http=${resp##*$'\n'}; resp=${resp%$'\n'*}

  if [[ $async == 1 ]] && id=$(jq -er '.id' <<<"$resp" 2>/dev/null); then
    for _ in $(seq 1 40); do
      resp=$(curl -sS --max-time 30 "$API$path/$id")
      [[ $(jq -r '.status' <<<"$resp" 2>/dev/null) =~ ^(scraping|processing|pending|queued)$ ]] || break
      sleep 3
    done
  fi
  [[ -z $scrape_id ]] && scrape_id=$(jq -r '.data.metadata.scrapeId // empty' <<<"$resp" 2>/dev/null)

  printf '%s\n' "$resp" >"$OUT/$name.json"
  if [[ $(jq -r "$evidence" <<<"$resp" 2>/dev/null) == true ]]; then res=OK; else res=FAIL; fi
  printf '%-30s %-4s %-4s %s\n' "$name" "$http" "$res" "$(note "$resp")"
done <<<"$CASES"

# monitor.create leaves an hourly monitor behind; remove it.
mid=$(jq -r '.data.id // empty' "$OUT/monitor.create.json" 2>/dev/null)
[[ -n $mid ]] && curl -s -o /dev/null -X DELETE "$API/v2/monitor/$mid"

# /v2/parse takes a multipart upload, so uploads get their own calls.
#   upload <name> <file> <content-type> <jq evidence> [options JSON]
upload() {
  [[ $1 =~ $FILTER ]] || return 0
  local resp http res opts=()
  [[ -n ${5:-} ]] && opts=(-F "options=$5")
  resp=$(curl -sS --max-time 300 -w $'\n%{http_code}' -X POST "$API/v2/parse" -F "file=@$2;type=$3" ${opts[@]+"${opts[@]}"})
  http=${resp##*$'\n'}; resp=${resp%$'\n'*}
  printf '%s\n' "$resp" >"$OUT/$1.json"
  [[ $(jq -r "$4" <<<"$resp" 2>/dev/null) == true ]] && res=OK || res=FAIL
  printf '%-30s %-4s %-4s %s\n' "$1" "$http" "$res" "$(note "$resp")"
}
f="$OUT/sample.html"; printf '<html><body><h1>Hello parse</h1><p>Local file.</p></body></html>' >"$f"
upload parse.upload "$f" text/html '.data.markdown|test("Hello parse")'
# OCR (Phase 8): a scanned PDF with no text layer, and a PNG of the same page.
SCANNED="$(dirname "$0")/../../apps/api/src/__tests__/snips/fixtures/parse-scanned.pdf"
upload file.pdf-ocr "$SCANNED" application/pdf '.data.markdown|test("Valve 7")' \
  '{"parsers":[{"type":"pdf","mode":"auto","pages":true}]}'
sips -s format png "$SCANNED" --out "$OUT/scanned.png" >/dev/null 2>&1
upload file.image-ocr "$OUT/scanned.png" image/png '.data.markdown|test("Valve 7")'

# Three-step flow: ask for an upload URL, PUT the file, parse by reference.
if [[ parse.upload-url =~ $FILTER ]]; then
  f="$OUT/sample-ref.html"; printf '<html><body><h1>Upload ref works</h1></body></html>' >"$f"
  ref=$(curl -sS --max-time 30 -X POST "$API/v2/parse/upload-url" -H 'Content-Type: application/json' \
    -d '{"filename":"sample-ref.html","contentType":"text/html"}')
  up=$(jq -r '.data.uploadUrl // empty' <<<"$ref" 2>/dev/null)
  resp=$ref http=n/a res=FAIL
  if [[ -n $up ]]; then
    curl -sS --max-time 30 -o /dev/null -X PUT "$up" -H 'Content-Type: text/html' --data-binary "@$f"
    resp=$(curl -sS --max-time 120 -w $'\n%{http_code}' -X POST "$API/v2/parse" -H 'Content-Type: application/json' \
      -d "{\"uploadRef\":\"$(jq -r '.data.uploadRef' <<<"$ref")\"}")
    http=${resp##*$'\n'}; resp=${resp%$'\n'*}
    [[ $(jq -r '.data.markdown|test("Upload ref works")' <<<"$resp" 2>/dev/null) == true ]] && res=OK
  fi
  printf '%s\n' "$resp" >"$OUT/parse.upload-url.json"
  printf '%-30s %-4s %-4s %s\n' parse.upload-url "$http" "$res" "$(note "$resp")"
fi

echo "raw responses: $OUT"
