# branch.js — אפיון

## מטרה
יצירת בראנץ' העבודה של ההסבה מתוך בראנץ' מקור, ותיוג נקודת ההתחלה.

**digital_V2 הוא היעד שנוצר, לא המקור.** המשתמש עומד על בראנץ' כלשהו
(או מציין אותו ב---source), והסקריפט יוצר ממנו בראנץ' חדש שמכיל את ההסבה.

## CLI
| דגל | ברירת מחדל |
|---|---|
| `--source <branch>` | הבראנץ' הנוכחי (HEAD) |
| `--target <branch>` | `defaultTarget` מהקונפיג (`digital_V2`) |
| `--dry-run` | מדפיס את רצף הפקודות בלי להריץ |
| `--json` | אובייקט תוצאה במקום טקסט |

## קונפיגורציה — reference/commit-steps.json
```json
{
  "defaultTarget": "digital_V2",
  "defaultSource": null,
  "protectedBranches": ["main", "master"]
}
```
`defaultSource: null` פירושו "הבראנץ' הנוכחי".
**אין לקודד שמות בראנצ'ים בסקריפט.**

## רצף
1. ולידציה: ריפו git תקין, לא detached HEAD, עץ עבודה נקי
2. פתרון המקור: `--source` ← קונפיג ← הבראנץ' הנוכחי
3. פתרון היעד: `--target` ← `defaultTarget` מהקונפיג
4. מקור ויעד חייבים להיות שונים
5. `git fetch origin --prune` — אם אין origin, דלג והוסף note
6. בדיקת קיום היעד → שלושת המצבים (ראה "מצבי היעד")
7. ביצירה: checkout למקור, pull אם יש upstream, `git checkout -b <target>`
8. תיוג: `migration-start-<YYYYMMDD-HHmm>`

## מצבי היעד

| מצב | תוצאה |
|---|---|
| היעד לא קיים (לא מקומית ולא ב-origin) | צור אותו, תייג → OK |
| היעד קיים ו-HEAD עומד עליו | השלב כבר בוצע. ודא שתג `migration-start-*` קיים, צור אם חסר → NOOP עם note שמסביר שהבראנץ' נוצר בהרצה קודמת |
| היעד קיים ו-HEAD במקום אחר | BLOCKED: השירות כנראה כבר הוסב. ההודעה מציעה `--target` אחר |

## מקרי קצה
| מצב | תוצאה |
|---|---|
| detached HEAD | BLOCKED — אין ממה להסתעף |
| עץ עבודה לא נקי | BLOCKED. **אל תבצע stash** — זו החלטת אדם |
| בראנץ' המקור לא קיים | BLOCKED, ההודעה מציעה `--source` |
| למקור אין upstream | דלג על ה-pull, הוסף note. **אל תיכשל** |
| `pull --ff-only` נכשל (diverged) | BLOCKED. **אל תבצע merge או rebase** |
| אין origin בכלל | דלג על fetch ו-pull, הוסף note |
| שם התג כבר קיים ומצביע לאותו commit | השתמש בו מחדש, הוסף note |
| שם התג קיים ומצביע למקום אחר | BLOCKED — המתן דקה והרץ שוב |

## פלט JSON
```json
{
  "script": "branch",
  "result": "OK",
  "sourceBranch": "try-skill",
  "targetBranch": "digital_V2",
  "tag": "migration-start-20261008-1524",
  "previousBranch": "try-skill",
  "previousHead": "<sha מלא לפני השינוי>",
  "changes": [], "manual": [], "blockers": [], "notes": []
}
```

`previousHead` ו-`tag` הם מה שמאפשר שחזור מלא, אז שניהם חובה בפלט.

## חוזה
- קוד יציאה 0 לכל תוצאה צפויה, כולל BLOCKED. קוד 1 רק לקריסה
- כל הפלט ל-stdout
- שורה אחרונה: `RESULT: OK|NOOP|BLOCKED`
- `--dry-run` לא נוגע בריפו כלל
- `execFileSync` עם מערך ארגומנטים. **אל תבנה מחרוזות פקודה עם קלט משתמש**
- **לעולם לא `git push`**

## בדיקות
golden fixtures לכל אחד משלושת המצבים של היעד, למקור בלי upstream,
ל-detached HEAD, ולריפו בלי origin.
