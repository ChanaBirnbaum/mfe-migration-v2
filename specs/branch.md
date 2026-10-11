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
1. ולידציה: ריפו git תקין, לא detached HEAD, עץ עבודה נקי — **בכל ארבעת מצבי היעד**
2. פתרון היעד: `--target` ← `defaultTarget` מהקונפיג
3. בדיקת קיום היעד (מקומית / ב-origin) → ארבעת המצבים (ראה "מצבי היעד")
4. רק ביצירה: פתרון המקור `--source` ← קונפיג ← הבראנץ' הנוכחי; מקור ויעד חייבים להיות שונים
5. `git fetch origin --prune` — אם אין origin, דלג והוסף note
6. ביצירה: checkout למקור, pull אם יש upstream, `git checkout -b <target>`.
   ביעד קיים: `git checkout <target>` (או `checkout -b <target> --track origin/<target>` אם קיים רק ב-origin). **בלי pull**
7. תיוג: `migration-start-<YYYYMMDD-HHmm>` — ביצירה ובמצב 4 בלבד

## מצבי היעד

**יעד קיים אינו חסימה.** כל השלבים idempotent, ולכן הסקיל ממשיך על בראנץ' קיים ומריץ רק את מה שנשאר.
תרחיש: מפתח התחיל הסבה ידנית לפי המדריך, יצר `digital_V2` בעצמו, נתקע, ורוצה שהסקיל יסיים.

| # | מצב | `targetMode` | פעולה | תוצאה |
|---|---|---|---|---|
| 1 | היעד לא קיים (לא מקומית ולא ב-origin) | `create` | צור מהמקור, תייג | OK |
| 2 | היעד קיים ו-HEAD עומד עליו | `on-target` | ודא שיש תג `migration-start-*` בהיסטוריה של HEAD, צור על HEAD אם חסר | NOOP, note: נוצר בהרצה קודמת |
| 3 | היעד קיים, HEAD במקום אחר, ויש תג `migration-start-*` בהיסטוריה שלו | `resume` | checkout. לא נוצר תג חדש; `tag` = התג האחרון בהיסטוריה | OK, note: "ממשיכים הסבה קיימת" |
| 4 | היעד קיים, HEAD במקום אחר, ואין תג | `adopt` | checkout, ואז תייג את **ה-HEAD הנוכחי של היעד** כנקודת שחזור | OK, note בולט: "הבראנץ' קיים אך לא נוצר ע"י הסקיל. ההסבה תרוץ על גביו. שלבים שכבר בוצעו ידנית יחזירו NOOP" |

### מצב 4 — לאן מצביע התג
התג נוצר **אחרי** ה-checkout, על הקצה של היעד כפי שהוא. **אסור** ליצור תג שמצביע ל-commit
שלא הסתעפנו ממנו (המקור / ה-HEAD הקודם): הסקיל לא יצר את הבראנץ' מנקודה זו, ו-rollback
לתג כזה היה מוחק את העבודה הידנית שעל היעד. נקודת השחזור היא "היעד לפני שהסקיל נגע בו".

### ההחלטה האנושית
branch.js לא חוסם במצב 4. ההחלטה היא בנקודת האישור של `run.js`: הודעת האישור אומרת במפורש
שהבראנץ' כבר היה קיים, שלא נוצר ע"י הסקיל, ושההסבה תרוץ על גביו (ראה "run.js" למטה).

### סיווג ב---dry-run
הסיווג resume / adopt נעשה מול `refs/heads/<target>`, או `refs/remotes/origin/<target>` אם קיים רק ב-origin.
יעד שקיים רק ב-origin ועדיין לא נמשך → מניחים adopt (השמרני — האזהרה מוצגת) ומוסיפים note.
בהרצה אמיתית הסיווג הסופי נעשה אחרי ה-checkout, מול HEAD.

## מקרי קצה
| מצב | תוצאה |
|---|---|
| detached HEAD | BLOCKED — אין ממה להסתעף |
| עץ עבודה לא נקי | BLOCKED בכל ארבעת מצבי היעד (גם כש-HEAD כבר על היעד). **אל תבצע stash** — זו החלטת אדם |
| בראנץ' המקור לא קיים | BLOCKED, ההודעה מציעה `--source` (רק במצב 1 — ביעד קיים המקור לא בשימוש) |
| `--source` ניתן אבל היעד קיים | מתעלמים ממנו, note |
| מצב 4: שם התג תפוס ומצביע לקצה אחר | BLOCKED, חזרה לבראנץ' הקודם |
| מצב 4: יצירת התג נכשלה | BLOCKED, חזרה לבראנץ' הקודם |
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
  "targetMode": "create",
  "changes": [], "manual": [], "blockers": [], "notes": []
}
```

`previousHead` ו-`tag` הם מה שמאפשר שחזור מלא, אז שניהם חובה בפלט.
`targetMode`: `create | on-target | resume | adopt`. במצבים 2–4 `sourceBranch` הוא `null`.

## run.js — נקודת האישור
ה-probe (`--dry-run`) מחזיר `targetMode`, והודעת האישור תלויה בו:

| `targetMode` | הודעה |
|---|---|
| `create` | `Approval needed: create <target> from <source>` |
| `resume` | `Approval needed: continue the existing migration on <target> (start tag <tag>)` |
| `adopt` | `Approval needed: run the migration on the EXISTING branch <target>` + שורות ⚠: הבראנץ' כבר היה קיים ולא נוצר ע"י הסקיל; ההסבה תרוץ על גביו; שלבים שבוצעו ידנית יחזירו NOOP; נקודת השחזור היא תג חדש על הקצה הנוכחי של היעד |
| `on-target` (NOOP) | אין עצירה |

`pause.targetMode` ו-`pause.targetExisted` בפלט ה-JSON של run.js.

## חוזה
- קוד יציאה 0 לכל תוצאה צפויה, כולל BLOCKED. קוד 1 רק לקריסה
- כל הפלט ל-stdout
- שורה אחרונה: `RESULT: OK|NOOP|BLOCKED`
- `--dry-run` לא נוגע בריפו כלל
- `execFileSync` עם מערך ארגומנטים. **אל תבנה מחרוזות פקודה עם קלט משתמש**
- **לעולם לא `git push`**

## בדיקות
golden fixtures לכל אחד מארבעת המצבים של היעד, למקור בלי upstream,
ל-detached HEAD, ולריפו בלי origin. למצבים 3 ו-4 גם בדיקת אינטגרציה עם git אמיתי:
- מצב 3: אחרי יצירה, חזרה ל-main והרצה שוב → checkout ליעד, אין תג חדש
- מצב 4: digital_V2 נוצר ידנית עם commit משלו → התג מצביע לקצה של היעד, **לא** ל-main;
  הרצה נוספת → NOOP
