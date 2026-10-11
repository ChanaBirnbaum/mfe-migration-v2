# מצב stub — אפיון

## מטרה
להריץ את הצינור במלואו (כולל install, build, verify-runtime ו-report) ממחשב שאין לו גישה ל-registry
הפנימי, שבו `@ips/mfe-shared-deps` לא קיים.

עקיפה של preflight לבדה לא מספיקה: `package-json.js` מוסיף את החבילה ל-dependencies, ו-`install.js`
ייכשל עליה. לכן החבילה צריכה להיות זמינה **מקומית** — דרך stub שמחקה את החוזה של `buildSharedGen1`.

**מצב stub נכנס לפעולה אוטומטית — ורק — כשהחבילה הפנימית אינה זמינה, ותמיד באישור אדם.**

## חבילת ה-stub
`test-fixtures/ips-mfe-shared-deps/` — ‏`package.json` (`0.0.0-stub`, ‏`private`) ו-`index.js`.
`index.js` מייצא `buildSharedGen1({ pkg, require, role })` ו-`FederationConfigError` לפי החוזה:

| role | `requiredVersion` | `import` |
|---|---|---|
| `host` / `standalone` | הטווח המוצהר (או `^<מותקן>`) | (נארז) |
| `remote` | `<רצפת דור 1> \|\| <טווח>`, למשל `^17.0.0 \|\| ^18.3.1` | `false` |

role לא חוקי, `pkg` / `require` חסרים, חבילה רק ב-devDependencies, או מוצהרת ולא מותקנת → `FederationConfigError`.
**זה לא הקוד האמיתי.** הרצה שהשתמשה בו אינה מאמתת התנהגות federation אמיתית.

## חלוקת אחריות

| רכיב | תפקיד |
|---|---|
| `reference/versions.json` → `"internal"` | רשימת החבילות הפנימיות. **רק** הן יכולות לקבל stub |
| `preflight.js` | **מדווח** בלבד: חבילה פנימית שה-registry המוגדר מחזיר עליה "לא נמצא" (E404 / הגרסה לא קיימת) ויש לה תיקייה ב-`test-fixtures/` → לא חוסם. סטטוס הבדיקה `stub-available`, ובפלט `stubCandidates: [...]`. timeout או שגיאה אחרת אינם הוכחה שהחבילה חסרה ונשארים חוסמים. חבילה שאינה פנימית → חוסם, כמו קודם |
| `run.js` | **מחליט**, באישור: PAUSE מסוג `stub-mode`. שומר את ההחלטה ב-`state.stubMode` |
| `scripts/stub-mode.js` | עזר משותף (לא שלב): זיהוי המצב, הנתיב ל-stub, הסימון בפלט |
| השלבים | קוראים את המצב דרך `MFE_MIGRATION_STUB` (מ-run.js), ואם אינו מוגדר — מ-`.migration/state.json` |

## ההחלטה — run.js
אחרי preflight עם `stubCandidates` לא ריק, לפני השלב הבא:

| מצב | התנהגות |
|---|---|
| אין החלטה | `PAUSE`, ‏`pause.kind: 'stub-mode'`, ‏`pause.key: 'stub.mode'`. ההודעה: אילו חבילות פנימיות לא נמצאו ובאיזה registry; שאפשר להמשיך עם stub מקומי; שהרצה כזו מאמתת את מנגנון הצינור בלבד ולא את קונפיגורציית ה-shared מול החבילה האמיתית; שלא יבוצעו commits |
| `--resume --answer stub.mode=yes` | מאושר, נשמר ב-`state.stubMode = { approved: true, packages, registry, approvedAt, approvedBy }`. `--resume` הבא לא שואל שוב |
| `--yes` | מאושר אוטומטית — **ההסבר והאזהרות מודפסים בכל זאת** |
| `--answer stub.mode=<כל ערך אחר>` | נעצר כמו היום: PAUSE מסוג `blocked` על preflight, עם החבילה שלא נמצאה. `--resume` מריץ את preflight מחדש |
| `--dry-run` | אין עצירה. המצב מדומה (עם שורת אזהרה) כדי ששאר השלבים יראו את מה שיקרה |
| preflight רץ שוב ומוצא את החבילה | `state.stubMode` נמחק — **לעולם לא stub לחבילה זמינה** |
| `--from <שלב מאוחר>` | ההחלטה נשמרת (preflight לא רץ שוב). `--from preflight` מחליט מחדש |

run.js מגדיר `MFE_MIGRATION_STUB` **לכל** שלב: רשימת החבילות במצב stub, או מחרוזת ריקה. ערך ריק מכבה במפורש,
כך שמשתנה סביבה שהוגדר ידנית לא יפעיל stub.

## התנהגות במצב stub

| שלב | התנהגות |
|---|---|
| `package-json` | לחבילות שב-stub בלבד: `dependencies["@ips/mfe-shared-deps"] = "file:<נתיב מוחלט ל-test-fixtures/ips-mfe-shared-deps>"` במקום הגרסה. **בודק שוב מול ה-registry**: אם החבילה זמינה → BLOCKED, ה-stub לא נכתב. מחוץ למצב stub, ערך `file:` של stub מהרצה קודמת מוחלף בגרסה האמיתית |
| `install` | רץ כרגיל; ה-`file:` נפתר מקומית (npm יוצר קישור ל-`test-fixtures/`). ה-note אומר ש-`package-lock.json` **אסור** ל-commit |
| `webpack-validate`, ‏`build`, ‏`verify-runtime` | רצים כרגיל מול ה-stub |
| `commit-mechanical`, ‏`commit-infra`, ‏`commit-build-fixes` | **מדולגים לגמרי**: run.js לא מריץ את `commit.js`, ‏NOOP עם note שמסביר למה. גם `commit.js` עצמו מחזיר NOOP במצב stub, ובלי מצב stub הוא מסרב (BLOCKED, ‏`stub-dependency`) כש-`package.json` מצביע ל-stub. אין דגל שעוקף את זה |
| `report` | הדוח כרגיל, עם סעיף ראשון ובולט (ראה "נראות") |

הסיבה לדילוג על ה-commits: `package.json` מכיל `file:` שמצביע לנתיב מקומי. בראנץ' הסבה עם תלות כזו
שבור אצל כל מי שימשוך אותו. אסור שזה ייכנס ל-commit בשום מצב.

## נראות
אסור שמישהו יסתכל על "הצינור הושלם" ויחשוב שהכל אומת.

- **כל שלב** שרץ במצב stub: שורת `⚠ STUB MODE – …` מתחת לשורת השלב ב-run.js, ושורת באנר בראש הפלט הטקסטואלי של הסקריפט
- **כל פלט `--json`**: ‏`stubMode: true` ו-`stubPackages` ברמה העליונה (גם של run.js), והאזהרה כ-note הראשון. גם ב-`build-<n>.json`
- **`MIGRATION-V2-REPORT.md`**: סעיף ראשון אחרי הכותרת — `⚠️ STUB RUN – this is NOT a validated migration`:
  שההרצה השתמשה ב-stub מקומי במקום החבילה; מה הוכח (בראנץ', קודמודים, התקנה, בנייה, בדיקת runtime, דוח — עם התוצאה של כל אחד);
  מה לא הוכח (קונפיגורציית ה-shared מול החבילה האמיתית); שלא בוצעו commits והעץ נשאר עם שינויים לא מחויבים;
  שנדרשת הרצה חוזרת על הרשת הפנימית לפני שימוש אמיתי. בנוסף, פריט ראשון ב-checklist
- **סיום run.js**: במקום `✅ The pipeline is complete` — ארבע שורות `⚠` שחוזרות על כל זה, ושורת `⚠ STUB MODE` מעל `RESULT:`

## מה לא לעשות
- אין דגל עקיפה כללי (`--skip-preflight` וכדומה)
- אין stub לחבילה שאינה ב-`internal`, או שאין לה תיקייה ב-`test-fixtures/`
- אין commit במצב stub, גם לא עם דגל
- אין stub כשהחבילה הפנימית כן זמינה, גם אם המשתמש מבקש

## בדיקות
- `tests/stub-shared-deps.test.js` — ה-stub עצמו: המבנה לשלושת ה-roles, ‏`FederationConfigError` על role לא חוקי,
  ו-remote עם react ‏`^18.3.1` → ‏`requiredVersion: "^17.0.0 || ^18.3.1"`
- `tests/stub-mode.test.js` — העזר המשותף: זיהוי מ-env / state, סינון ל-internal, הסימון בפלט
- preflight: חבילה פנימית חסרה → `stub-available`; timeout / שגיאה / חבילה ציבורית / בלי תיקיית stub → חוסם
- package-json: ‏`file:` מוחלט, רק לחבילות ה-stub; חבילה זמינה → BLOCKED; החלפת stub ישן בגרסה אמיתית
- commit: NOOP במצב stub (env או state), BLOCKED על `package.json` עם stub מחוץ למצב stub
- install: הרצה אמיתית של npm עם `file:` ל-stub ו-registry לא נגיש → ההתקנה מצליחה ו-`buildSharedGen1` נטען
- report: הסעיף הראשון; run.js: ‏PAUSE, אישור, `--yes`, סירוב, dry-run, ביטול כשהחבילה חוזרת, דילוג על commits, האזהרות
