# Consulta de patente: deuda y multas (CABA + Provincia de Buenos Aires)

Script que, a partir de una patente argentina, consulta en los **portales oficiales**:

| Qué | Portal | ¿Captcha? |
| --- | --- | --- |
| Deuda de patente PBA (impuesto automotor) | ARBA, *Liquidación contado y sin trámite*: <http://www14.arba.gov.ar/Liquidacion/jsp/generarLiquidacion.jsp?imp=1> (respaldo: [Aviso de Deudas](https://app.arba.gov.ar/AvisoDeudas/?imp=1)) | No (el respaldo sí) |
| Deuda de patente CABA | AGIP: <https://lb.agip.gob.ar/ConsultaPat/> | Sí |
| Multas de tránsito CABA | <https://buenosaires.gob.ar/licenciasdeconducir/consulta-de-infracciones/?actas=transito> | Sí |
| Multas de tránsito PBA | InfraccionesBA: <https://infraccionesba.gba.gob.ar/> → *Consultar/Pagar infracciones* (`/consulta-infraccion`) | Sí |

Al final arma un resumen corto (se lee bien en el celular) y guarda las capturas de cada portal.

## Requisitos

- [Node.js](https://nodejs.org/) 18 o superior.
- Google Chrome instalado. Si no lo tenés, después del `npm install` corré `npx playwright install chromium`.

## Instalación

```bash
git clone https://github.com/vmrodriguez90/cecilia-caserotto.git consulta-patente
cd consulta-patente
npm install
```

## Uso

```bash
node consulta-patente.mjs NQM444
```

La patente puede ir con o sin espacios o guiones (`nqm 444`, `AB-123-CD`).

1. ARBA se consulta directo, sin abrir ninguna pestaña.
2. Se abre Chrome con una pestaña por cada portal que pide captcha, con la patente ya completada.
3. El script te lleva de a una pestaña y te dice qué hacer en la terminal: tildás "No soy un robot" (y resolvés las imágenes si las pide) y el script aprieta *Consultar* o *Buscar* solo.
4. Si un portal está caído o no te interesa, escribí `s` y Enter en la terminal para saltearlo.
5. Al terminar se imprime el resumen y queda guardado en `resultados/<PATENTE>_<fecha>/`:
   - `resumen.md`: el mismo resumen de la terminal.
   - `datos.json`: todo lo que devolvió cada portal.
   - `*.png`: captura de pantalla de cada resultado. *Ante cualquier duda, la captura es lo que vale.*
   - `patente-pba-liquidacion.pdf`: si ARBA liquida deuda, el PDF que genera.

### Opciones

| Opción | Para qué |
| --- | --- |
| `--solo patente-pba,multas-pba` | Consultar sólo algunas fuentes (`patente-caba`, `patente-pba`, `multas-caba`, `multas-pba`). |
| `--minutos 5` | Tiempo máximo de espera por portal (default 5). |
| `--anios 10` | Años hacia atrás para buscar cuotas vencidas en AGIP (default 10; el sitio por defecto muestra sólo desde el año pasado). |
| `--salida carpeta` | Dónde guardar los resultados (default `./resultados`). |
| `--navegador chromium` | Usar el Chromium de Playwright en vez de Chrome. |
| `--cerrar` | Cerrar el navegador al terminar sin preguntar. |

Por ejemplo, para ver solamente la deuda de patente en provincia (no pide captcha):

```bash
node consulta-patente.mjs NQM444 --solo patente-pba --cerrar
```

## Ejemplo de resumen

```
# Patente AB123CD
Consulta: 31/10/2026 15:30

## Deuda de patente

### Deuda de patente CABA (AGIP)
- Vehículo: FIAT CRONOS 1.3 · estado: ACTIVO
- 3 cuotas impagas (vencidas o del mes) · total $ 65.000,50
  - 10/03/2019 · 2019 cuota 03 · $ 15.000,50 · vencida  ⚠ +5 años: podría estar prescripta (orientativo)
  - 12/06/2025 · 2025 cuota 06 · $ 20.000,00 · vencida
  - 10/10/2026 · 2026 cuota 10 · $ 30.000,00 · del mes en curso
- Además hay 1 cuota(s) a vencer por $ 31.000,00.

### Deuda de patente Provincia de Buenos Aires (ARBA)
- ✔ ARBA: "NO EXISTE DEUDA PARA EL CONTRIBUYENTE INGRESADO".

## Multas de tránsito

### Multas CABA
- ✔ El portal indica que no hay deuda/infracciones.

### Multas Provincia de Buenos Aires (InfraccionesBA)
- 2 actas · total $ 218.765,40
  - 01/06/2023 · causa 01-123-00456789-0 · Juzgado de Faltas de Pilar · $ 98.765,40 · Pendiente de pago  ⚠ +2 años: podría estar prescripta si es leve (orientativo)
  - 15/09/2026 · causa 01-999-00000001-0 · $ 120.000,00 · En término
```

(Los datos del ejemplo son ficticios.)

## Reglas que respeta el script

- **No resuelve captchas.** Los resolvés vos; el script sólo detecta que ya están resueltos para apretar el botón.
- **No paga ni inicia pagos**, ni carga datos de tarjeta. Sólo lee.
- **Sólo usa los sitios oficiales** (`agip.gob.ar`, `arba.gov.ar`, `buenosaires.gob.ar`, `gba.gob.ar`).

## Limitaciones a tener en cuenta

- **AGIP** e **InfraccionesBA** devuelven JSON, así que el resumen es exacto. **Multas CABA** devuelve una página HTML: el script lee tablas y montos lo mejor que puede, pero conviene confirmar con la captura.
- **ARBA** se consulta con la *liquidación contado y sin trámite*, que distingue "no existe deuda", "dominio inexistente" o genera un PDF con la liquidación. Deuda en juicio (apremio) o en plan de pagos puede no figurar ahí; para verla completa, entrá al [Aviso de Deudas](https://app.arba.gov.ar/AvisoDeudas/?imp=1). Si la liquidación no responde, el script usa el Aviso de Deudas (con captcha de imagen) como respaldo.
- **La patente se paga donde está radicado el auto**: un auto de CABA aparece en AGIP y no en ARBA, y al revés. Uno de los dos va a decir que no lo encuentra, y es normal.
- **InfraccionesBA pagina los resultados**: si hay más actas de las que entran en la primera página, el resumen te avisa y el resto lo ves en la pestaña.
- **Municipios bonaerenses con sistema propio** (no integrados a InfraccionesBA) pueden tener actas que no aparecen acá.
- **Prescripción**: las alertas son orientativas, no asesoramiento legal (multas CABA: 5 años; multas PBA: 2 años leves / 5 graves; patentes: 5 años). Planes de pago, apremios o actos judiciales la interrumpen.
- **AGIP tiene un firewall** que rechaza navegadores automatizados desde servidores (data centers). Desde tu compu, con Chrome, no debería pasar; si pasa, el script lo avisa y sigue con los demás.
- Los portales cambian. Si alguno deja de funcionar, el script te lo dice y sigue con los demás; la consulta a mano sigue disponible en la pestaña abierta.

## Tests

```bash
npm test
```

Prueba el flujo completo contra versiones **simuladas** de los portales (no sale nada a internet): captcha rechazado y reintento, auto no radicado, que no se envíe dos veces la consulta, lectura de cada respuesta y armado del resumen.

## Privacidad

El navegador usa un perfil propio en `~/.consulta-patente/perfil` (así los captchas suelen ser más fáciles las veces siguientes). Ahí quedan las cookies de estos portales; podés borrar esa carpeta cuando quieras. Los resultados quedan sólo en tu computadora, en la carpeta `resultados/`.
