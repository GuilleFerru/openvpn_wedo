# WEDO — ThingsBoard Color Palette

Paleta de colores de identidad WEDO adaptada para ThingsBoard.  
Generada a partir de los colores oficiales de marca: **Pantone 158 C** (naranja), **Pantone 426 C** (oscuro) y **Pantone 422 C** (gris).

---

## Colores base de marca

| Nombre | Pantone | HEX | RGB | Uso |
|--------|---------|-----|-----|-----|
| Naranja WEDO | 158 C | `#EE7623` | 238, 118, 35 | Color primario / acento |
| Oscuro WEDO | 426 C | `#24272A` | 36, 39, 42 | Fondo principal |
| Gris WEDO | 422 C | `#9EA1A2` | 158, 161, 162 | Fondo secundario / neutro |

---

## Accent Palette — Naranja WEDO

> Usar en ThingsBoard → **White labeling → Accent palette**  
> Base: `#EE7623` · Hue 24.5° · Saturación ~86%

```json
{
  "50":   "#f7f4f1",
  "100":  "#f1e3d9",
  "200":  "#eac6ad",
  "300":  "#e8a271",
  "400":  "#e8843f",
  "500":  "#ee7623",
  "600":  "#e3650f",
  "700":  "#c8580b",
  "800":  "#ac4b09",
  "900":  "#853a06",
  "A100": "#eaccb7",
  "A200": "#e8a271",
  "A400": "#dc610b",
  "A700": "#9a4206"
}
```

### Referencia visual de stops

| Stop | HEX | Descripción |
|------|-----|-------------|
| 50 | `#f7f4f1` | Tint muy claro — fondos sutiles |
| 100 | `#f1e3d9` | Tint claro |
| 200 | `#eac6ad` | Tint medio-claro |
| 300 | `#e8a271` | HUE 1 — naranja suave |
| 400 | `#e8843f` | Naranja intermedio |
| **500** | **`#ee7623`** | **Color principal WEDO** · Primary background |
| 600 | `#e3650f` | Naranja oscuro · Secondary background |
| 700 | `#c8580b` | Oscuro cálido |
| 800 | `#ac4b09` | HUE 2 — naranja profundo |
| 900 | `#853a06` | Tono más oscuro |
| A100 | `#eaccb7` | HUE 3 — accent claro |
| A200 | `#e8a271` | Accent medio |
| A400 | `#dc610b` | Accent saturado |
| A700 | `#9a4206` | Accent oscuro |

---

## Primary Palette — Oscuro WEDO

> Base oscuro: `#24272A` · Tints derivados del gris WEDO `#9EA1A2`

```json
{
  "50":   "#f4f4f4",
  "100":  "#e5e5e5",
  "200":  "#cbcccc",
  "300":  "#acaeae",
  "400":  "#919495",
  "500":  "#24272a",
  "600":  "#353b41",
  "700":  "#424a53",
  "800":  "#4e5a65",
  "900":  "#191a1b",
  "A100": "#e0e0e0",
  "A200": "#bbbdbd",
  "A400": "#8c8f90",
  "A700": "#3e454d"
}
```

### Referencia visual de stops

| Stop | HEX | Descripción |
|------|-----|-------------|
| 50 | `#f4f4f4` | Blanco roto — fondos de página |
| 100 | `#e5e5e5` | Gris muy claro |
| 200 | `#cbcccc` | Gris claro |
| 300 | `#acaeae` | HUE 1 — gris WEDO claro |
| 400 | `#919495` | Gris medio |
| **500** | **`#24272a`** | **Oscuro principal WEDO** · Primary background |
| 600 | `#353b41` | Oscuro intermedio · Secondary background |
| 700 | `#424a53` | Oscuro azulado |
| 800 | `#4e5a65` | HUE 2 — oscuro con tono azul |
| 900 | `#191a1b` | Negro WEDO |
| A100 | `#e0e0e0` | HUE 3 — gris accent claro |
| A200 | `#bbbdbd` | Gris accent medio |
| A400 | `#8c8f90` | Gris accent |
| A700 | `#3e454d` | Oscuro accent |

---

## Uso en widgets de ThingsBoard

### CSS custom properties sugeridas

Incluir en el bloque `<style>` de cada widget para referenciar la paleta de forma consistente:

```css
:root {
  /* Colores base WEDO */
  --wedo-orange:        #EE7623;
  --wedo-dark:          #24272A;
  --wedo-gray:          #9EA1A2;

  /* Accent — escala naranja */
  --accent-50:          #f7f4f1;
  --accent-100:         #f1e3d9;
  --accent-200:         #eac6ad;
  --accent-300:         #e8a271;
  --accent-400:         #e8843f;
  --accent-500:         #ee7623;  /* principal */
  --accent-600:         #e3650f;
  --accent-700:         #c8580b;
  --accent-800:         #ac4b09;
  --accent-900:         #853a06;

  /* Primary — escala oscura */
  --primary-50:         #f4f4f4;
  --primary-100:        #e5e5e5;
  --primary-200:        #cbcccc;
  --primary-300:        #acaeae;
  --primary-400:        #919495;
  --primary-500:        #24272a;  /* principal */
  --primary-600:        #353b41;
  --primary-700:        #424a53;
  --primary-800:        #4e5a65;
  --primary-900:        #191a1b;
}
```

### Convención de uso recomendada

| Contexto | Variable sugerida |
|----------|-------------------|
| Fondo de widget (dark) | `--primary-500` · `#24272a` |
| Fondo de card / panel | `--primary-600` · `#353b41` |
| Bordes y separadores | `--primary-700` · `#424a53` |
| Texto principal | `#f0f1f2` |
| Texto secundario / muted | `--primary-300` · `#acaeae` |
| Acento / highlight | `--accent-500` · `#ee7623` |
| Acento hover | `--accent-600` · `#e3650f` |
| Estado online / success | `#3ddc84` |
| Estado warning | `#f5c518` |
| Estado offline / danger | `#e05252` |

---

## Notas de implementación

- El stop **500** de cada paleta es el que ThingsBoard toma como color base en `Primary background` y `Accent`.
- El stop **600** se asigna automáticamente como `Secondary background`.
- Los stops **A100 / A200 / A400 / A700** son los "accent" variants — ThingsBoard los usa para estados hover, focus y elementos interactivos secundarios.
- Para textos sobre fondos oscuros (`--primary-500` o más oscuro) usar siempre `#f0f1f2` o `--primary-50`.
- Para textos sobre el naranja (`--accent-500`) usar `--primary-900` (`#191a1b`) para garantizar contraste suficiente (ratio > 4.5:1).

---

*Paleta generada a partir de la identidad visual WEDO — Pantone 158 C / 426 C / 422 C*  
*Compatible con ThingsBoard 3.x — Material Design palette format*
