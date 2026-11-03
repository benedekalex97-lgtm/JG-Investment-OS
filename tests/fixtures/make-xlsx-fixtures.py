"""Fiktív XLSX tesztfájlok előállítása openpyxl-lel (külső, valós táblázatkezelő-könyvtár kimenete a kompatibilitás ellenőrzéséhez).

Futtatás (a repó gyökeréből): python3 tests/fixtures/make-xlsx-fixtures.py
Kizárólag fiktív adat (example.test domain, 000-s telefonszámok). Valós ügyféladat nincs benne.
"""
from pathlib import Path
from openpyxl import Workbook

out = Path(__file__).parent
wb = Workbook()
ws = wb.active
ws.title = "Ügyfelek"
ws.append(["Név", "Telefon", "E-mail", "Ügyféltípus", "Cégnév", "Kapcsolattartó", "Megjegyzés"])
ws.append(["Fiktív Ferenc", 36300000101, "fiktiv.ferenc@example.test", "Magánszemély", None, None, "Első sor"])
ws.append([None, "06 1 000 0102", "info@fiktiv-bt.example.test", "Cég", "Fiktív Bt.", "Kapcsoló Klára", None])
ws.append(["Képletes Kornél", None, None, "Magánszemély", None, None, None])
ws["B4"] = "=1+1"
ws.append(["Ékezetes Őrs Űrhajós", "+36 20 000 0104", "ORS@EXAMPLE.TEST", "magánszemély", None, None, "Több\nsoros"])
ws.append([])
ws.append(["Üres sor utáni Üzenet", None, "uzenet@example.test", "Magánszemély", None, None, None])
other = wb.create_sheet("Másik lap")
other.append(["Cégnév", "Ügyféltípus"])
other.append(["Második Lap Kft.", "Cég"])
hidden = wb.create_sheet("Rejtett")
hidden.sheet_state = "hidden"
hidden.append(["x"])
wb.save(out / "openpyxl-customers.xlsx")
print("ok")
