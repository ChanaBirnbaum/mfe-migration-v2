# התקנת הסקיל mfe-migration-v2

## דרישות

- Node 18 ומעלה, git, npm
- גישה ל-registry הפנימי (התלות היחידה של הסקיל היא `ts-morph`)
- Claude Code

## התקנה

1. העתק את תיקיית הסקיל כולה לאחד מהמיקומים:

   | מיקום | זמין ב- |
   |---|---|
   | `~/.claude/skills/mfe-migration-v2/` | כל הפרויקטים שלך |
   | `<ריפו>/.claude/skills/mfe-migration-v2/` | ריפו אחד, משותף לצוות דרך git |

   `SKILL.md` חייב להיות בשורש התיקייה הזו.

2. התקן את התלויות **בתוך תיקיית הסקיל**:

   ```bash
   cd ~/.claude/skills/mfe-migration-v2
   npm ci
   ```

   הסקריפטים טוענים את `ts-morph` מ-`node_modules` שליד `scripts/`. בלי השלב הזה כל קודמוד יחזיר
   `BLOCKED` עם הודעה שמפנה לכאן.

3. בדיקה (אופציונלי):

   ```bash
   npm test
   ```

## שימוש

פתח את Claude Code **בשורש הריפו של השירות** ובקש הסבה לדור 2. Claude יריץ:

```bash
node <תיקיית הסקיל>/scripts/run.js
```

כל קבצי העבודה נכתבים לשירות ולא לסקיל:

| נתיב בשירות | תוכן |
|---|---|
| `.migration/state.json` | המצב של הצינור – מאפשר `--resume` |
| `.migration/<שלב>.json`, `.migration/build-<n>.json` | הפלט של כל שלב, הקלט של הדוח |
| `.migration/backup/` | גיבויים לפני החלפת קבצים |
| `MIGRATION-V2-REPORT.md` | הדוח הסופי – לא נכנס ל-commit אוטומטית |

run.js מוסיף את `.migration/` ל-`.git/info/exclude` של השירות, כך שהתיקייה לא נכנסת ל-commit ולא נחשבת שינוי פתוח.

## עדכון

החלף את תיקיית הסקיל בגרסה החדשה והרץ שוב `npm ci`.

## מה לא נכנס לתיקיית הסקיל ב-git

`node_modules/` ו-`.migration/` מוחרגים ב-`.gitignore`. אם `.migration/` מופיע בתוך תיקיית הסקיל,
מישהו הריץ סקריפט בודד מתוכה – מחק אותו. run.js עצמו מסרב לרוץ שם.
