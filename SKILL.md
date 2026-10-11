---
name: mfe-migration-v2
description: הסבת שירות MFE מ-React 17 + Material-UI v4 ל-React 18 + MUI v7 (הסבה לדור 2, buildSharedGen1). יוצר מהבראנץ' הנוכחי בראנץ' חדש digital_V2 שמכיל את ההסבה. Migrates an MFE service repo from React 17 / Material-UI v4 to React 18 / MUI v7 with Module Federation shared deps via buildSharedGen1, on a new digital_V2 branch created from the current branch. Use when asked to migrate a service to generation 2, React 18, MUI v7 or digital_V2, or to resume / fix such a migration.
---

# הסבת שירות MFE לדור 2

הסקיל מריץ צינור של 18 שלבים שמבצעים את כל השינויים בקוד. **התפקיד שלך הוא לא לבצע את ההסבה בעצמך**,
אלא להריץ את המתזמר, לקרוא את התוצאה, ולטפל בנקודות שבהן הוא עוצר.

**הבראנץ':** המשתמשת עומדת על בראנץ' כלשהו (או מציינת אותו). שלב `branch` יוצר ממנו בראנץ' **חדש** בשם
`digital_V2`, וכל ההסבה וה-commits נעשים עליו. `digital_V2` הוא **התוצר** של הסקיל, לא בראנץ' קיים שמסתעפים ממנו.
אם HEAD כבר עומד על `digital_V2` – השלב נחשב כבוצע (NOOP, ותג `migration-start-*` חסר נוצר). אם `digital_V2`
קיים (מקומית או ב-origin) אבל HEAD במקום אחר – הסקיל עובר אליו וממשיך עליו, אחרי אישור (ראה סוגי PAUSE).

## איך מריצים

`<skill-dir>` = התיקייה שבה נמצא קובץ ה-SKILL.md הזה.

הצינור רץ **משורש הריפו של השירות המוסב** – כל הסקריפטים מתייחסים ל-cwd כאל השירות:

```bash
cd <שורש השירות>
node <skill-dir>/scripts/run.js
```

- **אל תריץ מתוך `<skill-dir>`** – run.js יעצור עם `PAUSE` (`skill-dir`) ולא יכתוב דבר.
- `node scripts/run.js` מתוך השירות **לא יעבוד** – אין לשירות תיקיית scripts של הסקיל.
- הפקודה להמשך מודפסת תמיד בשורה `Next:` עם הנתיב המלא. העתק אותה כמו שהיא.
- כל הפלט של הסקריפטים באנגלית (עברית מתהפכת בטרמינל של Windows). הצג אותו למשתמשת כפי שהוא, או תרגם לפי הצורך.
- `--dry-run` מציג מה היה קורה בלי לכתוב דבר. השתמש בו כשהמשתמשת מבקשת לראות לפני.
- `--json` מחזיר אובייקט עם `pause.kind` ו-`next`, אם קל לך יותר לפרש אותו.

השורה האחרונה בפלט היא תמיד `RESULT: <ערך>`. קוד היציאה הוא 0 בכל מקרה צפוי – אל תסיק דבר מקוד היציאה.

## מה לעשות לפי התוצאה

| RESULT | מה קרה | מה לעשות |
|---|---|---|
| `OK` | הצינור הושלם | סכם למשתמשת לפי `MIGRATION-V2-REPORT.md` בשורש השירות: מה שונה, ובעיקר הסעיף "Needs manual handling". הדוח לא נכנס ל-commit – זו החלטה שלה. **אם הופיעו שורות `⚠ STUB MODE` / `IN STUB MODE`**: פתח את הסיכום בכך שזו הרצת stub שאינה הסבה מאומתת – לא בוצעו commits, ה-shared לא נבדק מול החבילה האמיתית, ונדרשת הרצה חוזרת ברשת הפנימית. אל תכתוב "ההסבה הושלמה" |
| `PAUSE` | עצירה בנקודת החלטה | ראה את הטבלה הבאה לפי סוג העצירה |
| `PAUSE_FOR_FIX` | ה-build נכשל | תקן את השגיאות – ראה "סבב תיקון build" |
| `FAILED` | סקריפט קרס (באג בסקריפט, לא בשירות) | הצג למשתמשת את שורות השגיאה שהודפסו. אל תנסה שוב בלי לברר |
| `NOOP` | אין מה להריץ | דווח שהצינור כבר הושלם |
| `BLOCKED` / `REVIEW` | **רק ב-`--dry-run`**: התוצאה הגרועה ביותר מבין השלבים (BLOCKED > REVIEW > OK) | הצג את הסיבות שהודפסו מתחת לכל שלב (⛔ חוסם, ✋ קובץ:שורה – סיבה). לא נכתב דבר ואין מה להמשיך |

**ב-`--dry-run` אין עצירה:** כל 18 השלבים רצים ברצף גם אם שלב נחסם. מכיוון שלא נכתב דבר, שלבים מאוחרים
רצים **בלי השינויים של הקודמים** (למשל build על קוד שלא הוסב), ולכן התוצאה שלהם אינה מעידה. רק התוצאות
של השלבים הראשונים (preflight, scan, branch) משקפות את מה שיקרה בהרצה אמיתית.

### סוגי PAUSE

| מופיע בפלט | `pause.kind` | מה לעשות |
|---|---|---|
| `Approval needed: create digital_V2 from <source>` | `approval` | **שאל את המשתמשת** אם להסתעף מהבראנץ' המוצג (ברירת מחדל: הבראנץ' הנוכחי, `pause.source`) ליצירת `digital_V2` (`pause.target`). אם הודפסו חוסמים (למשל עץ עבודה לא נקי) – הצג אותם קודם. אחרי אישור: הפקודה מ-`Next:` (`--answer branch.source=<מקור>`). מקור אחר: `--answer branch.source=<שם>`. שם יעד אחר: הוסף `--answer branch.target=<שם>` |
| `Approval needed: continue the existing migration on <target>` | `approval` (`pause.targetMode: resume`) | `digital_V2` כבר קיים עם תג `migration-start-*` – הסבה קודמת של הסקיל. **שאל את המשתמשת** אם להמשיך עליו. אחרי אישור: הפקודה מ-`Next:` |
| `Approval needed: run the migration on the EXISTING branch <target>` | `approval` (`pause.targetMode: adopt`) | `digital_V2` קיים אבל **לא נוצר ע"י הסקיל** (למשל הסבה ידנית שנתקעה). **הצג למשתמשת את שורות ה-⚠ כלשונן** ושאל במפורש אם להריץ את ההסבה על גבי הבראנץ' הקיים. אחרי אישור: הפקודה מ-`Next:`. אחרת: שם יעד אחר עם `--answer branch.target=<שם>` |
| `Approval needed: continue with a local stub for <package>` | `stub-mode` | חבילה פנימית (`pause.packages`) לא נמצאה ב-registry המוגדר (`pause.registry`) – כנראה אין גישה לרשת הפנימית. **הצג למשתמשת את שורות ה-⚠ כלשונן** ושאל במפורש אם להמשיך עם stub מקומי: הרצה כזו מאמתת רק את מנגנון הצינור, לא את קונפיגורציית ה-shared מול החבילה האמיתית, **ולא מבצעת אף commit**. אחרי אישור: `--resume --answer stub.mode=yes`. בלי אישור: להריץ ממקום עם גישה ל-registry הפנימי |
| `⏸ REVIEW` של שלב | `review` | השלב **רץ וביצע שינויים**, ויש פריטים שדורשים עין אנושית. הצג את כל הפריטים כפי שהודפסו (קובץ:שורה – סיבה). המשך עם `--resume` רק אחרי שהמשתמשת אישרה |
| `⛔ BLOCKED` של שלב | `blocked` | השלב **לא הושלם**. הצג את החסמים. אל תעקוף אותם – ראה "כללים". אחרי שהמשתמשת טיפלה: `--resume` מריץ את אותו שלב מחדש |
| `No progress` / `Reached the maximum` | `build-stalled` | עצור ושאל את המשתמשת איך להמשיך. אל תמשיך בסבבים על דעת עצמך |
| `A previous run did not finish` | `unfinished` | שאל אם להמשיך (`--resume`) או להתחיל מחדש (`--from preflight`) |
| `belongs to service` | `other-service` | ה-state של שירות אחר. ודא שאתה בתיקייה הנכונה |
| `No run to resume` | `no-state` | הרץ בלי `--resume` |
| `from inside the skill folder` | `skill-dir` | עבור לשורש השירות |
| `Unknown argument` / `Unknown step` | `args` | תקן את הפקודה – ההודעה מציעה את שם השלב הקרוב |

### סבב תיקון build

1. קרא את ה-diagnostics שהודפסו (קובץ:שורה:עמודה – הודעה). הרשימה המלאה ב-`.migration/build-<n>.json`.
2. חפש כל שגיאה ב-[reference/known-errors.md](reference/known-errors.md) ופעל לפי התיקון שם.
3. תקן בקוד המקור בלבד, בשינוי המינימלי. אל תבצע commit – השלב `commit-build-fixes` עושה זאת.
4. הרץ את הפקודה מ-`Next:` (`--resume`). run.js מריץ build שוב ומשווה למספר השגיאות הקודם.
5. עד 5 סבבים, ועצירה אם אין ירידה בשני סבבים רצופים.

## כללים

- **לעולם לא `git push`**. הסקריפטים לא דוחפים, וגם אתה לא.
- **לעולם לא `--legacy-peer-deps` או `--force`** ב-npm. קונפליקט peer deps הוא החלטה של המשתמשת.
- **לא `npm start`** – הוא פותח דפדפן. verify-runtime מריץ את השרת בעצמו.
- **build הוא `npm run build:dev`**. `npm run build` סתם קורס כי הקונפיג דורש `--env sviva=...`.
- **אל תוסיף לקוד** `useId`, `useSyncExternalStore`, `useTransition`, `useDeferredValue`, `useInsertionEffect` –
  תחת Host ישן השירות רץ על React 17. פירוט ב-[reference/coexistence.md](reference/coexistence.md).
- **אל תערוך את `.migration/`** – זה ה-state של הצינור.
- **מצב stub** ([specs/stub-mode.md](specs/stub-mode.md)): רק דרך ה-PAUSE של run.js, ורק כשהחבילה הפנימית באמת לא זמינה.
  אל תגדיר `MFE_MIGRATION_STUB` בעצמך, אל תכתוב `file:` ל-`package.json` ידנית, ואל תבצע commit בהרצת stub –
  `package.json` ו-`package-lock.json` מצביעים לנתיב מקומי, והבראנץ' יישבר אצל כל מי שימשוך אותו.
- **ספק → שאל.** אם לא ברור אם תיקון משנה התנהגות, הצג אותו למשתמשת לפני שאתה מבצע.
- הרצת שלב בודד: `--only <שלב>`. התחלה משלב: `--from <שלב>`. רשימת השלבים ב-[scripts/README.md](scripts/README.md).

## חומרי עזר

| קובץ | מתי |
|---|---|
| [reference/known-errors.md](reference/known-errors.md) | בכל סבב תיקון build |
| [reference/coexistence.md](reference/coexistence.md) | כשעולה שאלה על Host ישן מול חדש, או כש-verify-runtime מפנה אליו |
| [reference/mui-mapping.md](reference/mui-mapping.md) | כשצריך להמיר ידנית ייבוא של Material-UI v4 |
| [scripts/README.md](scripts/README.md) | פירוט כל שלב, הדגלים והפלטים |
