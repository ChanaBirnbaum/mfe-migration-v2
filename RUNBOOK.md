# הסבת שירות לדור 2 – הרצה ידנית מהטרמינל

הסקריפט מבצע את ההסבה: React 18, MUI v7 ו-`buildSharedGen1`. הוא עובד על בראנץ' חדש `digital_V2` ועושה commits לבד.
את ה-push עושים בעצמכם, בסוף.

זמן משוער: 15–30 דקות להרצה, ועוד זמן לתיקוני build אם יהיו.

---

## 0. התקנה (פעם אחת לכל מחשב)

> **חשוב:** את הסקריפט שמים **מחוץ** לריפו של השירות. לא ב-`.claude/skills` של השירות.
> אחרת git של השירות רואה אותו כקבצים חדשים, וההרצה נעצרת על "git לא נקי".

1. מעתיקים את התיקייה `mfe-migration-v2` ל-**`C:\tools\mfe-migration-v2`**.
   כל הפקודות בקובץ הזה מניחות את הנתיב הזה.
2. בטרמינל (PowerShell):

   ```powershell
   cd C:\tools\mfe-migration-v2
   npm ci
   ```

דרישות: Node 18 ומעלה, git, וגישה ל-registry הפנימי.

---

## 1. לפני ההרצה (בשירות)

```powershell
cd C:\path\to\my-service
git status
git checkout <הבראנץ' שממנו מסבים>
git pull
```

- [ ] `git status` נקי. אם לא: עושים commit או `git stash`.
- [ ] עומדים על הבראנץ' שממנו רוצים להסב. ממנו ייווצר `digital_V2`.
- [ ] **מומלץ:** מריצים `npm run build:dev` ומוודאים שהוא עובר **לפני** ההסבה.
      כך יודעים אילו שגיאות היו קיימות קודם ואילו נגרמו מההסבה.

---

## 2. הרצה

תמיד מתוך **שורש השירות**:

```powershell
node C:\tools\mfe-migration-v2\scripts\run.js
```

השורה האחרונה בפלט היא תמיד `RESULT: ...`. אם הסקריפט עצר, מופיעה מעליה שורה `Next:` עם הפקודה להמשך.
**מעתיקים את הפקודה מ-`Next:` כמו שהיא.**

| מה רואים | מה עושים |
|---|---|
| `Approval needed: create digital_V2 from <branch>` | מוודאים שזה הבראנץ' הנכון ומריצים את `Next:` |
| `Approval needed: continue the existing migration` | `digital_V2` כבר קיים מהרצה קודמת. מריצים את `Next:` כדי להמשיך |
| `Approval needed: run the migration on the EXISTING branch` | `digital_V2` קיים אבל לא נוצר ע"י הסקריפט. **עוצרים ומתייעצים** |
| `⏸ REVIEW` | השלב כבר ביצע שינויים, ויש מקומות שצריך לבדוק בעין (קובץ:שורה – סיבה). בודקים, מתקנים אם צריך, ומריצים את `Next:` |
| `⛔ BLOCKED` | מטפלים בסיבה שהודפסה ומריצים את `Next:` (`--resume`) |
| `🔧 PAUSE_FOR_FIX` | ה-build נכשל. ראו סעיף 3 |
| `continue with a local stub` | **לא מאשרים.** חבילה פנימית לא נמצאה, כנראה אין גישה ל-registry הפנימי. בודקים את הגדרות npm ומריצים שוב |
| `💥 FAILED` | באג בסקריפט. שומרים את הפלט ומעבירים לצוות הסקיל |
| `RESULT: OK` | סיימנו. ראו סעיף 4 |

**לא להשתמש ב-`--yes`.** הוא מאשר הכל אוטומטית, כולל מצב stub, ואז אף commit לא מתבצע.

---

## 3. תיקון שגיאות build (`PAUSE_FOR_FIX`)

1. השגיאות מודפסות בפורמט `קובץ:שורה:עמודה – הודעה`. הרשימה המלאה נמצאת ב-`.migration\build-<n>.json`.
2. מחפשים כל שגיאה ב-`C:\tools\mfe-migration-v2\reference\known-errors.md` ומתקנים לפי מה שכתוב שם.
3. מתקנים בקוד **בלי commit**. הסקריפט יעשה commit לתיקונים בעצמו.
4. מריצים את `Next:` (`--resume`). הסקריפט מריץ build שוב.

יש עד 5 סבבים. אם מופיע `No progress` או `Reached the maximum`, עוצרים ומתייעצים.

אסור: `npm install --force` / `--legacy-peer-deps`. אם יש קונפליקט peer deps, מתייעצים.

---

## 4. אחרי `RESULT: OK`

- [ ] קוראים את `MIGRATION-V2-REPORT.md` בשורש השירות, **בעיקר את הסעיף "Needs manual handling"**.
- [ ] מטפלים בפריטים הידניים מהדוח. אחרי זה: `git add` ו-`git commit` (את הדוח עצמו לא צריך להכניס).
- [ ] `npm start` ובדיקה ידנית של המסכים העיקריים.
- [ ] בודקים שהשירות עולה גם בתוך Host ישן (React 17) וגם בתוך Host חדש.
- [ ] `git log --oneline` – בודקים את ה-commits (`migration-v2: ...`).
- [ ] מעלים:

  ```powershell
  git push -u origin digital_V2
  ```

---

## להתחיל מההתחלה

```powershell
git checkout <בראנץ' המקור>
git branch -D digital_V2
Remove-Item -Recurse -Force .migration
node C:\tools\mfe-migration-v2\scripts\run.js
```

נקודת ההתחלה של ההסבה מתויגת כ-`migration-start-<תאריך>`. התגים מופיעים ב-`git tag -l "migration-start-*"`.

---

## טיפים

- רוצים לראות מה יקרה לפני ההרצה? `node C:\tools\mfe-migration-v2\scripts\run.js --dry-run` לא כותב כלום.
- לא מריצים את הסקריפט מתוך `C:\tools\mfe-migration-v2`, רק מתוך השירות.
- ב-PowerShell כותבים כל פקודה בשורה נפרדת, בלי `&&`.
- התיקייה `.migration\` היא ה-state של ההרצה. לא עורכים אותה, והיא לא נכנסת ל-commit.
