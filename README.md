# KI-PITAL

App para registrar Ingresos, Egresos y RRHH (colaboradores + nómina) de KI-PITAL. Funciona en el celular o tablet como una app instalada ("agregar a pantalla de inicio") y se sincroniza para todos los usuarios que tengan el link.

Fondo negro, letras en dorado.

## Módulos

- **Ingresos**: fecha, tipo (Tarjetas / Transferencia / Efectivo) y monto. Incluye filtro por período y desglose por tipo.
- **Egresos**: fecha, tipo (Alquiler, Salarios, CCSS, Agua, Luz, Internet, Insumos, Otros) y monto. Incluye filtro por período y desglose por tipo.
- **RRHH → Colaboradores**: datos personales (nombre, cédula, teléfono, correo, dirección), puesto, salario, tipo de pago, fecha de ingreso y estado (activo/inactivo).
- **RRHH → Nómina**: cálculo y procesamiento de planillas.
  - **Parámetros de nómina** (icono ⚙): porcentaje de CCSS del trabajador, cargas sociales patronales y tramos del impuesto sobre la renta. Vienen precargados con los valores de referencia de Costa Rica para 2026 (CCSS trabajador 10.67%, cargas patronales 26.83%) y se pueden ajustar cuando cambien por ley.
  - **Generar planilla**: elige el mes y la fecha de pago; la app trae automáticamente a los colaboradores activos con su salario base, permite agregar bonos/horas extra y otras deducciones por persona, y calcula en vivo el salario bruto, la deducción de CCSS, el impuesto de renta, el neto a pagar y el costo patronal (incluye cargas sociales).
  - Cada planilla guardada queda en un historial, se puede ver en detalle, descargar/compartir en PDF, y registrar automáticamente como egresos (Salarios = neto pagado, CCSS = cuota trabajador + cargas patronales, y Otros si hay renta retenida).

## Cómo funciona

No usa un servidor propio: los datos se guardan como archivos (`data/*.json`) dentro de este mismo repositorio de GitHub, y la app los lee/escribe con la API de GitHub. GitHub Pages sirve la app como una página web gratuita. Cada celular/computadora se conecta una sola vez con un "token" (como una contraseña de acceso a este repositorio).

La lista se actualiza sola cada 20 segundos y también al volver a abrir la app o la pestaña, así todos ven los mismos datos.

## Puesta en marcha (una sola vez)

### 1. Crear el repositorio en GitHub
1. Entra a tu cuenta de GitHub y crea un repositorio nuevo, por ejemplo `kipital-app`. Puede ser **privado** (recomendado).
2. Sube todos los archivos de esta carpeta (`index.html`, `style.css`, `app.js`, `manifest.json`, `icon.svg`, `sw.js`, la carpeta `data/`) a ese repositorio. Se puede hacer arrastrando los archivos desde la web de GitHub ("Add file → Upload files") o con git:

   ```bash
   cd kipital-app
   git init
   git add .
   git commit -m "KI-PITAL: ingresos, egresos y RRHH"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/kipital-app.git
   git push -u origin main
   ```

### 2. Activar GitHub Pages
1. En el repositorio, entra a **Settings → Pages**.
2. En "Source" elige **Deploy from a branch**, rama `main`, carpeta `/ (root)`.
3. Guarda. En un par de minutos GitHub te dará un link público, algo como `https://TU-USUARIO.github.io/kipital-app/`. Ese es el link que compartes con el equipo.

### 3. Crear el token de acceso (para que la app pueda leer y guardar los datos)
1. En GitHub ve a tu foto de perfil → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Ponle un nombre como "KI-PITAL app".
3. En "Repository access" elige **Only select repositories** y selecciona `kipital-app`.
4. En "Permissions" busca **Contents** y ponlo en **Read and write**.
5. Genera el token y cópialo (empieza con `github_pat_...`). Guárdalo en un lugar seguro — no se vuelve a mostrar.

> ⚠️ Este token da acceso de lectura/escritura **solo a este repositorio**. Aun así, no lo compartas por canales públicos; trátalo como una contraseña.

### 4. Conectar cada dispositivo
1. Abre el link de la app en el celular o tablet.
2. La primera vez pedirá **Configuración**: ingresa el usuario/organización de GitHub, el nombre del repositorio (`kipital-app`), la rama (`main`) y pega el token.
3. Toca **Guardar y conectar**. Repite esto en cada dispositivo del equipo (solo se hace una vez por dispositivo).
4. Usa "Agregar a pantalla de inicio" del navegador para que se vea como una app normal.

**Forma rápida para conectar un dispositivo nuevo:** en un dispositivo ya conectado, entra a Configuración y toca **"Copiar configuración para otro dispositivo"** — copia un código de texto (usuario|repositorio|rama|token) y envíalo por un canal privado. La otra persona lo pega en Configuración y toca **"Usar este código y conectar"**.

## Notas

- Si dos personas guardan un registro casi al mismo tiempo, la app reintenta automáticamente para no perder ninguno.
- Eliminar un colaborador no borra las planillas ya generadas con su información.
- "Registrar en Egresos" desde una planilla solo se puede hacer una vez por planilla, para evitar duplicar el gasto.
- Los porcentajes de CCSS, cargas patronales y los tramos de renta son editables en RRHH → Nómina → Parámetros, ya que la ley los ajusta con el tiempo.
