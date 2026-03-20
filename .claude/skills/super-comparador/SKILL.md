---
name: super-comparador
user_invocable: true
description: >
  Comparador de precios de supermercado entre Jumbo.cl, Lider.cl y Tottus.cl.
  Activar SIEMPRE que el usuario quiera comparar precios de supermercado, saber
  dónde le conviene comprar, optimizar su lista del super, o diga frases como
  "¿dónde es más barato?", "compara precios", "¿Jumbo o Lider?", "¿dónde conviene
  comprar X?", "compara mi lista", "¿en qué super me conviene?", "super comparador",
  o mencione querer dividir una compra entre supermercados para ahorrar.
  También activar si el usuario menciona una lista de compras y hay incertidumbre
  sobre dónde comprarla. Chris está suscrito a Jumbo Prime (despacho siempre gratis).
---

# Super Comparador — Jumbo vs Lider vs Tottus (ClaudeClaw / Playwright)

Compara precios de una lista de compras en los tres grandes supermercados online
de Chile y recomienda la combinación óptima (1, 2 o 3 pedidos) que minimiza el
**costo total incluyendo despacho**.

**Herramienta de browser**: Playwright MCP con Chrome real (headed, no headless). Herramientas disponibles:
`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
`browser_scroll`, `browser_take_screenshot`.
NO usar WebFetch — los sitios cargan productos via JavaScript.
⚠️ Lider y Tottus bloquean Chromium headless (CAPTCHA / Cloudflare). Chrome real headed los evita.

---

## Reglas de despacho (inamovibles en el cálculo)

| Supermercado | Costo de despacho | Mínimo |
|---|---|---|
| **Jumbo.cl** | $0 siempre (Jumbo Prime activo) | Sin mínimo |
| **Lider.cl** | $0 si total ≥ $49.990, sino **$3.990** | $49.990 |
| **Tottus.cl** | $0 si total ≥ $49.990, sino **$3.490** | $49.990 |

> Si Lider o Tottus no alcanzan el mínimo: sumar el costo de despacho al total
> para comparar honestamente. NO sugerir productos "relleno" para llegar al mínimo.

---

## Flujo obligatorio

### Fase 1 — Parsear la lista

- Si el usuario da texto libre: extraer producto, cantidad y preferencias (marca, tamaño)
- Si hay ambigüedad relevante para el precio (ej: "pollo" → pechuga / trutro / entero), preguntar antes de buscar
- Para pruebas: usar lista en texto del usuario
- **Producción (futuro)**: leer desde la base de datos de Notion indicada por el usuario

Estructura interna por ítem:
```
{ producto, cantidad, preferencia_marca, preferencia_tamaño }
```

### Fase 2 — Scraping de precios con Playwright MCP

Buscar cada producto en los 3 sitios **secuencialmente** (un sitio completo antes
de pasar al siguiente).

**Flujo por producto en cada sitio:**

1. `browser_navigate(url)` con la URL de búsqueda
2. Esperar 3-4 segundos (los SPA necesitan tiempo para cargar)
3. `browser_snapshot()` para leer el contenido de la página
4. Si los resultados no aparecen: `browser_scroll` hacia abajo y volver a hacer snapshot
5. Si hay un cookie banner: `browser_click` en el botón de cerrar/rechazar antes de leer

**URLs de búsqueda directa (verificadas 2026-03-20):**
```
Jumbo:  https://www.jumbo.cl/busqueda?ft=PRODUCTO       (⚠️ usar ?ft= NO ?q=)
Lider:  https://super.lider.cl/search?q=PRODUCTO        (⚠️ dominio es super.lider.cl)
Tottus: https://www.tottus.cl/tottus-cl/buscar?Ntt=PRODUCTO  (⚠️ /tottus-cl/buscar NO /tottus/search)
```

**Fallback si la URL directa no muestra resultados:**
Usar `browser_type` para escribir en el buscador del sitio y presionar Enter.
Esperar 3-4 segundos y hacer `browser_snapshot` nuevamente.

**Nota sobre Jumbo:** La URL `?q=` muestra página 404. SIEMPRE usar `?ft=`.
Jumbo requiere login para ver precios de despacho — puede que en modo headless
no haya sesión activa. Igualmente comparar precios de producto (son visibles sin login).
**Nota sobre Lider:** Los resultados cargan DEBAJO del fold. Siempre hacer
`browser_scroll` hacia abajo tras navegar y esperar.

**Por cada resultado capturar del `browser_snapshot()`:**
- Nombre exacto del producto encontrado
- Precio total del ítem
- Precio unitario / por kg / por litro (si aparece) — útil para comparar distintas presentaciones
- Disponibilidad

**Regla de selección de producto:** elegir el resultado más relevante y de tamaño/marca
más cercana a lo pedido. Si hay duda entre dos opciones, priorizar el de mejor precio
por unidad de medida. Anotar qué se eligió para mostrarlo en el informe.

**Si el producto no está disponible (N/D):**
- Marcarlo como ❌ N/D en ese supermercado
- **Excluirlo del total de ese supermercado** (no asumir precio ni poner $0)
- Continuar sin preguntar — se informa al final

**Si hay CAPTCHA o bloqueo:** detenerse, avisar al usuario, no intentar bypassear.

**Rechazar cookies/pop-ups** sin aceptar tracking innecesario.

### Fase 3 — Construir matriz de precios

Una vez completado el scraping de los 3 sitios, construir internamente:

```
productos[] = [
  {
    nombre_buscado: "arroz 1kg",
    jumbo:  { nombre: "Arroz Gallo 1kg", precio: 1290, disponible: true },
    lider:  { nombre: "Arroz Tucapel 1kg", precio: 1190, disponible: true },
    tottus: { nombre: "Arroz Gallo 1kg", precio: 1350, disponible: true }
  },
  ...
]
```

### Fase 4 — Calcular opciones de compra

Calcular **4 escenarios**:

1. **Todo en Jumbo** — suma de precios Jumbo disponibles + $0 despacho
2. **Todo en Lider** — suma de precios Lider disponibles + despacho si aplica
3. **Todo en Tottus** — suma de precios Tottus disponibles + despacho si aplica
4. **Combinación óptima** — asignar cada producto al supermercado más barato donde está disponible, luego:
   - Calcular subtotal por supermercado
   - Aplicar lógica de despacho a cada uno
   - Si un supermercado tiene ≤ 1 producto asignado y el ahorro al tenerlo separado es mínimo, considerar consolidar

**Para la combinación óptima**, si el split genera más de 1 pedido extra:
- Comparar costo total del split vs. consolidar en 1 supermercado
- Si la diferencia es **≤ $3.000**: presentar ambas opciones y **preguntar al usuario**

**Formato de pregunta al usuario (si aplica):**
> "La combinación óptima divide la compra en 2 pedidos y ahorra **$2.100** vs comprar
> todo en Jumbo. ¿Prefieres dividir la compra o ir con un solo pedido?"

### Fase 5 — Generar informe HTML

Mostrar informe como **Artifact HTML** con:

#### Tabla de precios por producto
- Una fila por producto
- Columnas: Producto buscado | Jumbo | Lider | Tottus | Recomendado
- Colorear el precio más bajo de cada fila en **verde** `#22c55e`
- Colorear el precio más alto en **rojo claro** `#fca5a5`
- Si N/D: mostrar "❌ N/D" en gris, sin colorear
- Columna "Recomendado": mostrar el logo/nombre del super más barato con ✅

#### Tabla resumen por escenario
```
ESCENARIO          | SUBTOTAL  | DESPACHO | TOTAL     | AHORRO VS JUMBO
Todo en Jumbo      | $XX.XXX   | $0       | $XX.XXX   | —
Todo en Lider      | $XX.XXX   | $0/$3.990| $XX.XXX   | -$X.XXX / +$X.XXX
Todo en Tottus     | $XX.XXX   | $0/$3.490| $XX.XXX   | -$X.XXX / +$X.XXX
🏆 Combinación opt.| $XX.XXX   | $X.XXX   | $XX.XXX   | -$X.XXX
```
- Destacar la **fila ganadora** con fondo verde suave y borde
- Mostrar ícono 🏆 en la combinación recomendada

#### Sección "Plan de compra recomendado"
Si la opción ganadora divide en múltiples pedidos, mostrar claramente:

```
📦 PEDIDO 1 — JUMBO.CL ($0 despacho · Jumbo Prime)
  • Arroz Gallo 1kg × 2         $2.580
  • Leche Soprole 1L × 3        $3.870
  Subtotal: $6.450

📦 PEDIDO 2 — LIDER.CL ($0 despacho · +$49.990)
  • Detergente Omo 3kg           $7.490
  • Aceite Naturaceite 1L × 2   $4.180
  Subtotal: $11.670

💰 TOTAL: $18.120  |  AHORRO: $2.340 vs comprar todo en Jumbo
```

#### Notas al pie
- Listar todos los productos ❌ N/D por supermercado
- Advertencia: "Precios capturados el [fecha]. Pueden variar al momento de hacer el pedido."
- "Chris está suscrito a Jumbo Prime — despacho siempre gratis en Jumbo."

---

## Reglas de calidad del informe

- Siempre mostrar el **nombre exacto del producto encontrado** (no el buscado) en la tabla, así el usuario puede verificar si es lo correcto
- Si un producto fue encontrado en presentación diferente a la pedida (ej: buscó 1kg pero solo había 500g), **notarlo con ⚠️** y ajustar el precio a la presentación comparable (ej: mostrar precio × 2 packs)
- No inventar precios ni asumir equivalencias sin notarlas

---

## Reglas de seguridad (inamovibles)

- **NUNCA agregar al carrito en este skill** — solo comparar. Para ejecutar la compra, usar el skill `jumbo-compras` (para Jumbo) o navegar manualmente.
- **NUNCA hacer checkout**
- **NUNCA ingresar datos de pago**
- **NUNCA bypassear CAPTCHA**

---

## Manejo de errores

| Situación | Acción |
|---|---|
| CAPTCHA o bloqueo en un sitio | Marcar ese sitio como ⚠️ No disponible, continuar con los otros 2 |
| Sitio lento / timeout | Reintentar 1 vez con `browser_snapshot`. Si falla: continuar con N/D para ese sitio |
| Producto no encontrado | ❌ N/D, excluir del total de ese super |
| Precio no visible en snapshot | `browser_take_screenshot` para diagnóstico, luego marcar como N/D si no se puede leer |
| Presentación diferente | ⚠️ Notarlo, ajustar precio a unidad comparable |
| browser_snapshot vacío | Hacer `browser_scroll` + esperar 2s + snapshot de nuevo |

---

## Tips de navegación con Playwright MCP (verificados 2026-03-20)

- **Jumbo**: `browser_navigate("https://www.jumbo.cl/busqueda?ft=leche+entera")` → esperar → `browser_snapshot()`. Capturar precio y precio/kg si aparece.
- **Lider**: `browser_navigate("https://super.lider.cl/search?q=leche+entera")` → esperar → `browser_scroll` hacia abajo (los resultados cargan bajo el fold) → `browser_snapshot()`. Verificar precio "Club Lider" vs normal — usar precio sin tarjeta.
- **Tottus**: `browser_navigate("https://www.tottus.cl/tottus-cl/buscar?Ntt=leche+entera")` → esperar → `browser_snapshot()`. La URL antigua `/tottus/search` da error SSL 526. Verificar precio con/sin CMR — usar precio sin tarjeta.
- Si hay cookie banner al abrir cualquier sitio: `browser_click` en el botón de cierre/rechazo antes de leer el contenido.
- Si `browser_snapshot` retorna poco contenido (página no cargó): esperar 3s, hacer `browser_scroll` y repetir.

---

## Lecciones aprendidas (actualizado 2026-03-20)

### Sobre los sitios
- Los 3 sitios cargan productos via JavaScript/SPA — WebFetch solo obtiene el shell HTML sin datos. **Obligatorio usar Playwright MCP**.
- **Lider y Tottus bloquean Chromium headless** (CAPTCHA anti-bot / Cloudflare). Playwright MCP está configurado con Chrome real (headed) para evitarlo — verificado 2026-03-20.
- Jumbo funciona correctamente. Precios de producto visibles sin login. Asumir $0 despacho por Jumbo Prime.
- Lider NO requiere login para ver precios. Los productos se muestran debajo de un hero banner grande — siempre hacer scroll down tras navegar a resultados.
- Tottus NO requiere login. La URL antigua `/tottus/search` está rota (SSL 526). La URL correcta es `/tottus-cl/buscar`.
- Los 3 sitios muestran un cookie banner. Cerrar con `browser_click` en la X cuando sea posible.

### Sobre precios y presentaciones
- Pollo deshuesado (tuto y pechuga) viene en packs de 750-850g, NO en 1kg exacto. Para granel (al peso) solo Jumbo ofrece pechuga granel. Anotar siempre la diferencia de gramaje.
- Verduras frescas (cebolla, zanahoria): Jumbo y Tottus venden granel en packs menores (500g). Lider tiende a vender solo en bolsas/mallas de 1kg. Esto afecta el total cuando se necesita poca cantidad.
- Maggi caldo en polvo 5 sobres es el producto más comparable entre los 3 supers. Diferencias de precio mínimas ($690-$730).

### Sobre despacho (factor decisivo)
- **Para compras chicas (<$30k):** Jumbo Prime gana siempre por despacho gratis sin mínimo.
- **Para compras medianas ($30k-$50k):** Lider y Tottus tienen despacho gratis sobre $49.990. Comparar subtotales.
- **Para compras grandes (>$50k):** Los 3 tienen despacho gratis. La comparación depende solo de precios unitarios.
- La combinación óptima (split entre supers) rara vez conviene en compras chicas porque cada super adicional suma su despacho.
