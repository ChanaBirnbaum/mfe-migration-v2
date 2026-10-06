---
name: mfe-migration-v2
description: הסבת שירות MFE מ-React 17 + Material-UI v4 ל-React 18 + MUI v7 (הסבה לדור 2, buildSharedGen1, בראנץ' digital_V2). Migrates an MFE service repo from React 17 / Material-UI v4 to React 18 / MUI v7 with Module Federation shared deps via buildSharedGen1. Use when asked to migrate a service to generation 2, React 18, MUI v7 or digital_V2, or to resume / fix such a migration.
---

# הסבת שירות MFE לדור 2

הסקיל מריץ צינור של 18 שלבים שמבצעים את כל השינויים בקוד. **התפקיד שלך הוא לא לבצע את ההסבה בעצמך**,
אלא להריץ את המתזמר, לקרוא את התוצאה, ולטפל בנקודות שבהן הוא עוצר.

## איך מריצים

`<skill-dir>` = התיקייה שבה נמצא קובץ ה-SKILL.md הזה.

הצינור רץ **משורש הריפו של השירות המוסב** – כל הסקריפטים מתייחסים ל-cwd כאל השירות:

```bash
cd <שורש השירות>
node <skill-dir>/scripts/run.js
```

- **אל תריץ מתוך `<skill-dir>`** – run.js יעצור עם `PAUSE` (`skill-dir`) ולא יכתוב דבר.
- `node scripts/run.js` מתוך השירות **לא יעבוד** – אין לשירות תיקיית scripts של הסקיל.
- הפקודה להמשך מודפסת תמיד בשורה `להמשך:` עם הנתיב המלא. העתק אותה כמו שהיא.
- `--dry-run` מציג מה היה קורה בלי לכתוב דבר. השתמש בו כשהמשתמשת מבקשת לראות לפני.
- `--json` מחזיר אובייקט עם `pause.kind` ו-`next`, אם קל לך יותר לפרש אותו.

השורה האחרונה בפלט היא תמיד `RESULT: <ערך>`. קוד היציאה הוא 0 בכל מקרה צפוי – אל תסיק דבר מקוד היציאה.

## מה לעשות לפי התוצאה

| RESULT | מה קרה | מה לעשות |
|---|---|---|
| `OK` | הצינור הושלם | סכם למשתמשת לפי `MIGRATION-V2-REPORT.md` בשורש השירות: מה שונה, ובעיקר הסעיף "דורש טיפול ידני". הדוח לא נכנס ל-commit – זו החלטה שלה |
| `PAUSE` | עצירה בנקודת החלטה | ראה את הטבלה הבאה לפי סוג העצירה |
| `PAUSE_FOR_FIX` | ה-build נכשל | תקן את השגיאות – ראה "סבב תיקון build" |
| `FAILED` | סקריפט קרס (באג בסקריפט, לא בשירות) | הצג למשתמשת את שורות השגיאה שהודפסו. אל תנסה שוב בלי לברר |
| `NOOP` | אין מה להריץ | דווח שהצינור כבר הושלם |

### סוגי PAUSE

| מופיע בפלט | `pause.kind` | מה לעשות |
|---|---|---|
| `נדרש אישור שם בראנץ'` | `approval` | **שאל את המשתמשת** אם שם הבראנץ' המוצע מתאים. אחרי אישור: הפקודה מ-`להמשך:` עם `--answer branch.target=<שם>` |
| `⏸ REVIEW` של שלב | `review` | השלב **רץ וביצע שינויים**, ויש פריטים שדורשים עין אנושית. הצג את כל הפריטים כפי שהודפסו (קובץ:שורה – סיבה). המשך עם `--resume` רק אחרי שהמשתמשת אישרה |
| `⛔ BLOCKED` של שלב | `blocked` | השלב **לא הושלם**. הצג את החסמים. אל תעקוף אותם – ראה "כללים". אחרי שהמשתמשת טיפלה: `--resume` מריץ את אותו שלב מחדש |
| `אין התקדמות` / `הגעה למקסימום` | `build-stalled` | עצור ושאל את המשתמשת איך להמשיך. אל תמשיך בסבבים על דעת עצמך |
| `קיימת ריצה שלא הסתיימה` | `unfinished` | שאל אם להמשיך (`--resume`) או להתחיל מחדש (`--from preflight`) |
| `שייך לשירות` | `other-service` | ה-state של שירות אחר. ודא שאתה בתיקייה הנכונה |
| `אין ריצה להמשיך` | `no-state` | הרץ בלי `--resume` |
| `מתוך תיקיית הסקיל` | `skill-dir` | עבור לשורש השירות |
| `פרמטר לא מוכר` / `שלב לא מוכר` | `args` | תקן את הפקודה – ההודעה מציעה את שם השלב הקרוב |

### סבב תיקון build

1. קרא את ה-diagnostics שהודפסו (קובץ:שורה:עמודה – הודעה). הרשימה המלאה ב-`.migration/build-<n>.json`.
2. חפש כל שגיאה ב-[reference/known-errors.md](reference/known-errors.md) ופעל לפי התיקון שם.
3. תקן בקוד המקור בלבד, בשינוי המינימלי. אל תבצע commit – השלב `commit-build-fixes` עושה זאת.
4. הרץ את הפקודה מ-`להמשך:` (`--resume`). run.js מריץ build שוב ומשווה למספר השגיאות הקודם.
5. עד 5 סבבים, ועצירה אם אין ירידה בשני סבבים רצופים.

## כללים

- **לעולם לא `git push`**. הסקריפטים לא דוחפים, וגם אתה לא.
- **לעולם לא `--legacy-peer-deps` או `--force`** ב-npm. קונפליקט peer deps הוא החלטה של המשתמשת.
- **לא `npm start`** – הוא פותח דפדפן. verify-runtime מריץ את השרת בעצמו.
- **build הוא `npm run build:dev`**. `npm run build` סתם קורס כי הקונפיג דורש `--env sviva=...`.
- **אל תוסיף לקוד** `useId`, `useSyncExternalStore`, `useTransition`, `useDeferredValue`, `useInsertionEffect` –
  תחת Host ישן השירות רץ על React 17. פירוט ב-[reference/coexistence.md](reference/coexistence.md).
- **אל תערוך את `.migration/`** – זה ה-state של הצינור.
- **ספק → שאל.** אם לא ברור אם תיקון משנה התנהגות, הצג אותו למשתמשת לפני שאתה מבצע.
- הרצת שלב בודד: `--only <שלב>`. התחלה משלב: `--from <שלב>`. רשימת השלבים ב-[scripts/README.md](scripts/README.md).

## חומרי עזר

| קובץ | מתי |
|---|---|
| [reference/known-errors.md](reference/known-errors.md) | בכל סבב תיקון build |
| [reference/coexistence.md](reference/coexistence.md) | כשעולה שאלה על Host ישן מול חדש, או כש-verify-runtime מפנה אליו |
| [reference/mui-mapping.md](reference/mui-mapping.md) | כשצריך להמיר ידנית ייבוא של Material-UI v4 |
| [scripts/README.md](scripts/README.md) | פירוט כל שלב, הדגלים והפלטים |
