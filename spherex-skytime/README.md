# SPHEREx SkyTime 🌌

**Explore the universe through SPHEREx observations.**

SPHEREx SkyTime is an interactive astronomical exploration platform that allows users to discover and explore observations from NASA's SPHEREx mission. It provides an interface for searching astronomical targets, viewing sky observations, inspecting FITS images, and comparing astronomical data.

## ✨ Features

- **Astronomical Target Discovery:** Explore and search for astronomical targets.
- **SPHEREx Observations:** Retrieve observations from the SPHEREx archive using sky coordinates.
- **Sky Visualization:** Explore astronomical survey data through an interactive sky viewer.
- **FITS Image Inspection:** Inspect astronomical FITS images and visualize image cutouts.
- **Image Comparison:** Compare FITS observations to identify differences.
- **Featured Observations:** Discover selected astronomical observations.
- **HiPS Integration:** Access HiPS survey resources through a backend proxy.

## 🛠️ Tech Stack

### Frontend
- React 19
- TypeScript
- Vite 8
- Tailwind CSS 4
- Aladin Lite

### Backend
- Node.js
- Express.js
- NASA/IPAC Infrared Science Archive (IRSA) services

## 📁 Project Structure

```text
SPHEREx-SkyTime/
├── dist/               # Production frontend build
├── server.ts           # Express backend and Vite integration
├── src/                # Frontend source code
├── public/             # Static assets
├── package.json        # Dependencies and scripts
├── package-lock.json   # Dependency lockfile
├── vite.config.ts      # Vite configuration
└── netlify.toml        # Netlify API proxy configuration
```

## 🚀 Getting Started

### Prerequisites

- Node.js 22.12 or later
- npm

### 1. Clone the repository

```bash
git clone YOUR_GITHUB_REPOSITORY_URL
cd SPHEREx-SkyTime
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start the development server

```bash
npm run dev
```

Open the local URL displayed in your terminal.

### 4. Build for production

```bash
npm run build
```

The production frontend files will be generated inside the `dist/` directory.

### 5. Run the production server

```bash
npm start
```

## 🌐 Deployment

SPHEREx SkyTime uses a separate frontend and backend deployment architecture.

- **Frontend:** Netlify
- **Backend:** Render

A static-only deployment is insufficient because the application relies on Express API endpoints for astronomical data retrieval and FITS processing.

### Backend Deployment – Render

1. Create a new Web Service on [Render](https://render.com/).
2. Connect your GitHub repository.
3. Configure the following settings:

| Setting | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm install && npm run build` |
| Start Command | `npm start` |
| Root Directory | Leave empty |

Set the following environment variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `22` |

After deployment, copy your Render service URL.

### Frontend Deployment – Netlify

1. Visit [Netlify](https://www.netlify.com/).
2. Select **Add new project → Import an existing project**.
3. Connect your GitHub account.
4. Select the SPHEREx SkyTime repository.
5. Configure the following:

| Setting | Value |
|---|---|
| Base Directory | Leave empty |
| Build Command | `npm run build` |
| Publish Directory | `dist` |
| Functions Directory | Leave empty |

### Configure API Proxy

Create a `netlify.toml` file in the repository root:

```toml
[[redirects]]
  from = "/api/*"
  to = "https://YOUR-RENDER-SERVICE.onrender.com/api/:splat"
  status = 200
  force = true
```

Replace `YOUR-RENDER-SERVICE` with your actual Render service hostname.

This configuration forwards frontend API requests to the Express backend.

## 🔌 API Endpoints

The Express backend provides the following endpoints:

| Endpoint | Description |
|---|---|
| `/api/health` | Backend health check |
| `/api/targets` | Retrieve astronomical target information |
| `/api/resolve-target` | Resolve astronomical object names |
| `/api/observations` | Retrieve SPHEREx observations |
| `/api/fits-inspect` | Inspect FITS images |
| `/api/fits-diff` | Compare FITS images |
| `/api/fits-single-hdu` | Retrieve a single-image FITS file |
| `/api/featured` | Retrieve featured observations |
| `/api/hips/:surveyId/*` | Proxy HiPS survey resources |

## 🔭 About SPHEREx

SPHEREx (Spectro-Photometer for the History of the Universe, Epoch of Reionization, and Ices Explorer) is a NASA space telescope mission designed to survey the entire sky in optical and near-infrared light across 102 wavelength bands.

The mission helps scientists investigate the origins of the universe, the history of galaxy formation, and the distribution of water and other essential molecules in planetary systems.

Learn more:
- [NASA SPHEREx Mission](https://science.nasa.gov/mission/spherex/)
- [NASA/IPAC Infrared Science Archive](https://irsa.ipac.caltech.edu/)

## 🧪 Troubleshooting

- **Frontend loads but data does not:** Verify that the Render backend is running and the Netlify API proxy points to the correct service URL.
- **API requests return 404:** Check the `netlify.toml` configuration and redeploy the Netlify site.
- **Build errors:** Verify your Node.js version and install dependencies again.
- **Slow initial API requests:** Some Render hosting plans may spin down inactive services, resulting in cold starts.
- **Archive requests fail:** Check backend logs and the availability of external NASA/IPAC services.

## 🙌 Acknowledgements & Credits

SPHEREx SkyTime was developed as a submission for the **NASA Space Apps Challenge** by **Team Lava Java**.

We would like to acknowledge and thank the following organizations, tools, and contributors that helped make this project possible.

### Data & Scientific Resources
- **NASA** – For the SPHEREx mission and the astronomical data that inspired and powered this project.
- **NASA/IPAC Infrared Science Archive (IRSA)** – For providing access to SPHEREx observational data and related astronomical resources.

### Libraries & Technologies
- **[Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/)** – For enabling interactive astronomical sky visualization and exploration.
- **[Google AI Studio](https://aistudio.google.com/)** – Used as the primary AI-assisted development environment during implementation.
- **[ChatGPT](https://chatgpt.com/)** – For development guidance, explanations, and assistance throughout the project.

### Project Contributors

**Crafted by Khushleen and Gopikrishna**

Developed with curiosity, collaboration, and a shared interest in exploring the universe through technology.

**Team:** Lava Java  
**Event:** NASA Space Apps Challenge

---

*SPHEREx SkyTime — Bringing the universe closer, one observation at a time.* 🌌

**Made with curiosity by Team Lava Java.**

