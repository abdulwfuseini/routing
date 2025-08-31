import React, { useEffect, useRef, useState, useCallback } from 'react';
import 'ol/ol.css';
import { Map, View } from 'ol';
import TileLayer from 'ol/layer/Tile';
import OSM from 'ol/source/OSM';
import XYZ from 'ol/source/XYZ';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import { Style, Stroke, Circle as CircleStyle, Fill } from 'ol/style';
import GeoJSON from 'ol/format/GeoJSON';
import { fromLonLat, transform, toLonLat } from 'ol/proj';
import * as dijkstra from 'dijkstrajs';
import { getDistance } from 'ol/sphere'; // OL function to calculate distance in meters



const VehicleMap = () => {
  const mapRef = useRef();
  const [mapObj, setMapObj] = useState(null);
  const [basemap, setBasemap] = useState('OSM');

  const [roadGraph, setRoadGraph] = useState({});
  const [clickPoints, setClickPoints] = useState([]);
  const [vehicleFeature, setVehicleFeature] = useState(null);
  const [animationInterval, setAnimationInterval] = useState(null);
  const [popupMessage, setPopupMessage] = useState('');
  const [addingPoints, setAddingPoints] = useState(false);

  // --- NEW: Layers state for multiple toggle ---
  const [layers, setLayers] = useState({
    roads: null,                // Roads
    tamaleBoundary: null,        // Greater Tamale Boundary
    tamaleMetro: null,          // Tamale Metro
    sagnarigu: null             // Sagnarigu
});

  const layerNames = {
    roads: "Roads",
    uhi: "UHI",
    tamaleBoundary: "Greater Tamale",
    tamaleMetro: "Tamale Metro",
    sagnarigu: "Sagnarigu"
    };

  // --- Vehicle emoji animation ---
  const [vehiclePos, setVehiclePos] = useState(0);
  const [vehicleDir, setVehicleDir] = useState(1); // 1 = right, -1 = left
  const [sidebarOpen, setSidebarOpen] = useState(true); // sidebar starts open
  const [distanceTravelled, setDistanceTravelled] = useState(0);


  
  // Vehicle animation in header
  useEffect(() => {
    const minPercent = 35;
    const maxPercent = 94;
    const interval = setInterval(() => {
      setVehiclePos(prev => {
        if (prev >= maxPercent) setVehicleDir(-1);
        if (prev <= minPercent) setVehicleDir(1);
        return prev + vehicleDir * 1;
      });
    }, 50);
    return () => clearInterval(interval);
  }, [vehicleDir]);

  // --- Function to get basemap ---
  const getBaseLayer = (name) => {
    try {
      switch (name) {
        case 'OSM': return new TileLayer({ source: new OSM(), visible: true });
        case 'OSM BlackWhite': return new TileLayer({ source: new XYZ({ url: 'https://tiles.wmflabs.org/bw-mapnik/{z}/{x}/{y}.png' }), visible: true });
        case 'Carto Dark': return new TileLayer({ source: new XYZ({ url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png', attributions: '© OpenStreetMap contributors © CARTO' }), visible: true });
        case 'Carto Light': return new TileLayer({ source: new XYZ({ url: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png', attributions: '© OpenStreetMap contributors © CARTO' }), visible: true });
        case 'OpenTopoMap': return new TileLayer({ source: new XYZ({ url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png', attributions: '© OpenTopoMap contributors' }), visible: true });
        case 'Esri World Imagery': return new TileLayer({ source: new XYZ({ url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attributions: '© Esri, Maxar, Earthstar Geographics' }), visible: true });
        default: return new TileLayer({ source: new OSM(), visible: true });
      }
    } catch (err) {
      console.error('Failed to load basemap:', name, err);
      return new TileLayer({ source: new OSM(), visible: true });
    }
  };


  const [pointLayer, setPointLayer] = useState(null);

  useEffect(() => {
        if (!mapObj) return;
        if (!pointLayer) {
            const layer = new VectorLayer({ source: new VectorSource(), style: new Style({
            image: new CircleStyle({ radius: 6, fill: new Fill({ color: 'green' }) })
            }) });
            mapObj.addLayer(layer);
            setPointLayer(layer);
        }
        }, [mapObj, pointLayer]);


  useEffect(() => {
        if (!mapObj) return;

        const handlePointerMove = () => {
            mapObj.getTargetElement().style.cursor = addingPoints ? 'crosshair' : 'grab';
        };

        mapObj.on('pointermove', handlePointerMove);
        return () => mapObj.un('pointermove', handlePointerMove);
        }, [mapObj, addingPoints]);


  // --- Main Map Initialization ---
  useEffect(() => {
    const baseLayer = getBaseLayer(basemap);

    const map = new Map({
      target: mapRef.current,
      layers: [baseLayer],
      view: new View({ center: fromLonLat([-0.8393, 9.4008]), zoom: 15 })
    });




    // --- 1️⃣ Load Roads GeoJSON ---
    fetch(`${process.env.PUBLIC_URL}/greater_tamale_road.geojson`)
      .then(res => res.json())
      .then(data => {
        const format = new GeoJSON();
        const features = format.readFeatures(data);
        // Reproject from EPSG:32630 -> EPSG:3857
        features.forEach(f =>
          f.getGeometry().applyTransform((coords, coords2, stride) => {
            for (let i = 0; i < coords.length; i += stride) {
              const [x, y] = transform([coords[i], coords[i + 1]], 'EPSG:32630', 'EPSG:3857');
              coords[i] = x;
              coords[i + 1] = y;
            }
          })
        );

        const roads = new VectorLayer({
  source: new VectorSource({ features }),
  style: (feature, resolution) => {
    // Calculate zoom from resolution
    const zoom = Math.round(Math.log2(40075016.68557849 / (resolution * 256)));
    const width = zoom >= 16 ? 2 : 0.2;
    return new Style({
      stroke: new Stroke({
        color: '#c64e04c4',
        width: width
      })
    });
  },
  visible: true
});


        map.addLayer(roads);
        setLayers(prev => ({ ...prev, roads }));
        

        map.getView().fit(roads.getSource().getExtent(), { padding: [50, 50, 50, 50] });

        // Build road graph
        const graph = {};
        features.forEach(f => {
          const coords = f.getGeometry().getCoordinates()[0];
          for (let i = 0; i < coords.length - 1; i++) {
            const a = coords[i], b = coords[i + 1];
            const keyA = `${a[0].toFixed(2)}|${a[1].toFixed(2)}`;
            const keyB = `${b[0].toFixed(2)}|${b[1].toFixed(2)}`;
            const distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (!graph[keyA]) graph[keyA] = {};
            if (!graph[keyB]) graph[keyB] = {};
            graph[keyA][keyB] = distance;
            graph[keyB][keyA] = distance;
          }
        });
        setRoadGraph(graph);
      });

    // --- Tamale Metro Boundary Layer ---
    const format = new GeoJSON();
    fetch('/tameleMetro.geojson')
    .then(res => res.json())
    .then(data => {
        const features = format.readFeatures(data, { dataProjection: 'EPSG:32630', featureProjection: 'EPSG:3857' });
        const tamaleMetroLayer = new VectorLayer({
        source: new VectorSource({ features }),
        style: new Style({
            stroke: new Stroke({ color: '#91cec6ff', width: 3, lineDash: [4,8] }),
            fill: new Fill({ color: 'rgba(0,0,255,0.1)' })
        }),
        visible: true
        });
        map.addLayer(tamaleMetroLayer);
        setLayers(prev => ({ ...prev, tamaleMetro: tamaleMetroLayer }));
    });

    fetch('/Sagnarigu.geojson')
    .then(res => res.json())
    .then(data => {
        const features = format.readFeatures(data, { dataProjection: 'EPSG:32630', featureProjection: 'EPSG:3857' });
        const sagnariguLayer = new VectorLayer({
        source: new VectorSource({ features }),
        style: new Style({
            stroke: new Stroke({ color: '#bad57cff', width: 3, lineDash: [4,8] }),
            fill: new Fill({ color: 'rgba(255,0,255,0.1)' })
        }),
        visible: true
        });
        map.addLayer(sagnariguLayer);
        setLayers(prev => ({ ...prev, sagnarigu: sagnariguLayer }));
    });
    


    // --- 3️⃣ Greater Tamale Boundary Layer (reprojected) ---
    fetch('/greater_tamale.geojson')
      .then(res => res.json())
      .then(data => {
        const format = new GeoJSON();
        const features = format.readFeatures(data);
        features.forEach(f =>
          f.getGeometry().applyTransform((coords, coords2, stride) => {
            for (let i = 0; i < coords.length; i += stride) {
              const [x, y] = transform([coords[i], coords[i + 1]], 'EPSG:32630', 'EPSG:3857');
              coords[i] = x;
              coords[i + 1] = y;
            }
          })
        );
        const boundaryLayer = new VectorLayer({
          source: new VectorSource({ features }),
          style: new Style({ stroke: new Stroke({ color: '#ff00e1ff', width: 2 }) }),
          visible: true
        });
        map.addLayer(boundaryLayer);
        setLayers(prev => ({ ...prev, tamaleBoundary: boundaryLayer }));
      });

    setMapObj(map);
    return () => map.setTarget(undefined);
  }, [basemap]);

  const changeBasemap = (name) => setBasemap(name);

  // --- Toggle Layer visibility ---
  const toggleLayer = (layerKey) => {
    if (!layers[layerKey]) return;
    layers[layerKey].setVisible(!layers[layerKey].getVisible());
  };

 


  // --- Map Click to select start/end points ---
  const handleMapClick = useCallback((event) => {
        if (!addingPoints || !layers.roads?.getVisible() || !mapObj) return;

        const clickedCoord = event.coordinate;
        let newPoints = [...clickPoints];

        if (newPoints.length === 0) {
            newPoints.push(clickedCoord);
        } else if (newPoints.length === 1) {
            newPoints[1] = clickedCoord;
        } else {
            newPoints = [clickedCoord];
            if (animationInterval) clearInterval(animationInterval);
            setAnimationInterval(null);
            if (vehicleFeature) vehicleFeature.getGeometry().setCoordinates(clickedCoord);
        }

        setClickPoints(newPoints);

        // Update single point layer
        const source = pointLayer.getSource();
        source.clear();
        newPoints.forEach((pt, idx) => {
            const feature = new Feature(new Point(pt));
            feature.setStyle(new Style({
            image: new CircleStyle({ radius: 6, fill: new Fill({ color: idx === 0 ? 'green' : 'blue' }) })
            }));
            source.addFeature(feature);
        });

        }, [addingPoints, clickPoints, mapObj, layers, animationInterval, vehicleFeature, pointLayer]);

  useEffect(() => { if (mapObj) mapObj.on('click', handleMapClick); return () => mapObj?.un('click', handleMapClick); }, [mapObj, handleMapClick]);

  // --- Driving animation with pulsing vehicle ---
  const startDriving = () => {
    if (!layers.roads?.getVisible()) { setPopupMessage('Turn on roads layer first!'); return; }
    if (clickPoints.length < 2 || !roadGraph || !mapObj) { setPopupMessage('Select start and end points!'); return; }

    const snapToGraph = coord => {
      let nearestKey = null, minDist = Infinity;
      Object.keys(roadGraph).forEach(k => {
        const [x, y] = k.split('|').map(Number);
        const d = Math.hypot(coord[0] - x, coord[1] - y);
        if (d < minDist) { nearestKey = k; minDist = d; }
      });
      return nearestKey;
    };
    
    const startKey = snapToGraph(clickPoints[0]);
    const endKey = snapToGraph(clickPoints[1]);
    if (!startKey || !endKey) return;



    let pathKeys;
    try { pathKeys = dijkstra.find_path(roadGraph, startKey, endKey); }
    catch { setPopupMessage('No path found along roads!'); return; }

    const routeCoords = pathKeys.map(k => k.split('|').map(Number));
    const travelFeature = new Feature({ geometry: new LineString([routeCoords[0]]) });
    const travelLayer = new VectorLayer({ source: new VectorSource({ features: [travelFeature] }) });
    mapObj.addLayer(travelLayer);

    let vehicle = vehicleFeature;
    if (!vehicle) {
      vehicle = new Feature(new Point(routeCoords[0]));
      vehicle.setStyle(new Style({ image: new CircleStyle({ radius: 10, fill: new Fill({ color: 'red' }), stroke: new Stroke({ color: 'yellow', width: 2 }) }) }));
      const vehicleLayer = new VectorLayer({ source: new VectorSource({ features: [vehicle] }) });
      mapObj.addLayer(vehicleLayer);
      setVehicleFeature(vehicle);
    } else vehicle.getGeometry().setCoordinates(routeCoords[0]);

    if (animationInterval) clearInterval(animationInterval);

    let i = 0;
let pulseRadius = 8;
let growing = true;

const interval = setInterval(() => {
  if (!layers.roads?.getVisible()) { 
    clearInterval(interval); 
    return; 
  }

  if (i < routeCoords.length - 1) {
    const prevCoord = routeCoords[i];       // previous point
    const currCoord = routeCoords[i + 1];   // next point

    // Update distance travelled
    if (prevCoord && currCoord) {
      const prevLonLat = toLonLat(prevCoord);
      const currLonLat = toLonLat(currCoord);
      const dist = getDistance(prevLonLat, currLonLat); // distance in meters
      setDistanceTravelled(prev => prev + dist);
    }

    // Move vehicle
    vehicle.getGeometry().setCoordinates(currCoord);

    // Pulse effect
    if (growing) pulseRadius += 0.5; else pulseRadius -= 0.5;
    if (pulseRadius >= 15) growing = false;
    if (pulseRadius <= 8) growing = true;
    vehicle.setStyle(new Style({
      image: new CircleStyle({ 
        radius: pulseRadius, 
        fill: new Fill({ color: 'red' }), 
        stroke: new Stroke({ color: 'yellow', width: 2 }) 
      })
    }));

    // Draw route so far
    travelFeature.getGeometry().setCoordinates(routeCoords.slice(0, i + 2));
    i++;
  } else clearInterval(interval);
}, 100);

setAnimationInterval(interval);
  };
 

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100%' }}>
      {/* Header */}
<div style={{
    background: '#2E3B4E',
    color: '#fff',
    padding: '15px',
    fontSize: '2rem',
    fontWeight: 'bold',
    position: 'relative',
    overflow: 'hidden',
    whiteSpace: 'nowrap'
}}>
    <span>Vehicle Animation Map</span>
    <div style={{ position: 'absolute', bottom: 5, width: '100%', height: '3px', background: '#fff' }}></div>
    <span style={{
        position: 'absolute',
        left: `${vehiclePos}%`,
        bottom: 0,
        fontSize: '3rem',
        transition: 'left 0.05s linear',
        transform: vehicleDir === 1 ? 'scaleX(-1)' : 'scaleX(1)'
    }}>🚗</span>
</div>

<div style={{
    display: 'flex',
    flexDirection: 'row',
    flex: 1,
    height: 'calc(100vh - 80px)', // adjust for header and footer
    overflow: 'hidden'
}}>
    {/* Sidebar */}
    <div
  style={{
    width: sidebarOpen ? '250px' : '60px', // collapsed width
    transition: 'width 0.3s ease',
    background: '#3B4A63',
    color: '#fff',
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: '0',
    boxShadow: '0 4px 8px rgba(0,0,0,0.2)',
    fontFamily: '"Inter", sans-serif',
    overflow: 'hidden'
  }}
>
        <button
  onClick={() => setSidebarOpen(!sidebarOpen)}
  style={{
    marginBottom: '15px',
    padding: '5px 10px',
    borderRadius: '8px',
    border: 'none',
    cursor: 'pointer',
    background: '#2196F3',
    color: '#fff',
    fontWeight: 'bold'
  }}
>
  {sidebarOpen ? 'Collapse' : 'Open'}
</button>


        {sidebarOpen && <>
            <label style={{ display: sidebarOpen ? 'block' : 'none' }}>Select A Basemap</label>
            <select
                onChange={e => changeBasemap(e.target.value)}
                value={basemap}
                style={{
                    padding: '10px',
                    borderRadius: '8px',
                    border: 'none',
                    backgroundColor: '#fff',
                    color: '#3B4A63',
                    fontWeight: 'bold',
                    fontSize: '14px',
                    cursor: 'pointer',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
                    marginBottom: '15px'
                }}>
                <option value="OSM">OpenStreetMap</option>
                <option value="OSM BlackWhite">OSM BlackWhite</option>
                <option value="Carto Dark">Carto Dark</option>
                <option value="Carto Light">Carto Light</option>
                <option value="OpenTopoMap">OpenTopoMap</option>
                <option value="Esri World Imagery">Esri World Imagery</option>
            </select>

            <h3 style={{ marginTop: '10px', marginBottom: '0', fontWeight: 'bold', fontSize: '1.5rem', color: '#fff' }}>Layers</h3>
            <div style={{ height: '1px', background: 'rgba(255,255,255,0.6)', margin: '4px 0 10px 0', width: '100%' }}></div>

            {Object.keys(layers).map(key => (
                <button
                    key={key}
                    onClick={() => toggleLayer(key)}
                    style={{
                        display: 'block',
                        width: '100%',
                        padding: '10px 15px',
                        marginBottom: '10px',
                        backgroundColor: layers[key]?.getVisible() ? '#4CAF50' : '#555',
                        color: '#fff',
                        fontWeight: '500',
                        fontSize: '16px',
                        border: 'none',
                        borderRadius: '25px',
                        cursor: 'pointer',
                        transition: 'all 0.3s ease',
                        textAlign: 'left'
                    }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = layers[key]?.getVisible() ? '#45a049' : '#666'}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = layers[key]?.getVisible() ? '#4CAF50' : '#555'}>
                    {layers[key]?.getVisible() ? '✔️' : '✖️'} {layerNames[key]}
                </button>
            ))}

            <button
                onClick={() => setAddingPoints(!addingPoints)}
                style={{
                    width: '100%',
                    padding: '12px 20px',
                    marginTop: '10px',
                    backgroundColor: addingPoints ? '#FF5722' : '#2196F3',
                    color: '#fff',
                    fontSize: '16px',
                    fontWeight: '600',
                    border: 'none',
                    borderRadius: '25px',
                    cursor: 'pointer',
                    transition: 'all 0.3s ease',
                    boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
                }}>
                {addingPoints ? 'Click on Map to Add Points' : 'Enable Add Points'}
            </button>

            <button
                onClick={startDriving}
                style={{
                    width: '100%',
                    padding: '12px 20px',
                    marginTop: '15px',
                    backgroundColor: '#2196F3',
                    color: '#fff',
                    fontSize: '16px',
                    fontWeight: '600',
                    border: 'none',
                    borderRadius: '25px',
                    cursor: 'pointer',
                    transition: 'all 0.3s ease',
                    boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
                }}>
                Start Driving <span style={{ display: 'inline-block', transform: 'scaleX(-1)' }}>🚗</span>
            </button>
                
            <div style={{
                marginTop: '20px',
                fontSize: '14px',
                backgroundColor: '#f5f7fa',
                padding: '15px',
                borderRadius: '12px',
                boxShadow: '0 4px 8px rgba(0, 0, 0, 0.1)',
                color: '#333',
                lineHeight: '1.6'
            }}>
                <div style={{
    marginTop: '20px',
    padding: '10px',
    backgroundColor: '#2E3B4E',
    color: '#fff',
    borderRadius: '8px',
    fontWeight: 'bold',
    fontSize: '16px',
    textAlign: 'center'
}}>
    Distance Travelled: {(distanceTravelled / 1000).toFixed(2)} km
</div>

                
                <p style={{ fontWeight: '600', fontSize: '16px', marginBottom: '10px', color: '#2E3B4E' }}>Instructions:</p>
                <ul style={{ paddingLeft: '20px', margin: 0 }}>
                    <li>Click on the map to select start and end points.</li>
                    <li>Toggle layers on/off using checkboxes.</li>
                    <li>Click <span style={{ fontWeight: '600', color: '#2196F3' }}>"Start Driving"</span> to animate the vehicle.</li>
                </ul>
            </div>
        </>}
    </div>

    {/* Map */}
    <div style={{ flex: 1, position: 'relative' }}>
        <div ref={mapRef} style={{ width: '100%', height: '100%' }}></div>

        {popupMessage && (
            <div style={{
                position: 'absolute',
                top: '20px',
                left: '50%',
                transform: 'translateX(-50%)',
                background: '#f9f9f9',
                border: '2px solid #4CAF50',
                padding: '10px',
                borderRadius: '8px',
                zIndex: 2000
            }}>
                <div>{popupMessage}</div>
                <button onClick={() => setPopupMessage('')} style={{ marginTop: '5px', padding: '5px', cursor: 'pointer' }}>Close</button>
            </div>
        )}
    </div>
</div>

<footer style={{
    background: '#3B4A63',
    color: '#fff',
    textAlign: 'center',
    padding: '10px',
    fontSize: '14px',
    width: '100%',
    borderTop: '1px solid #555',
    position: 'relative'
}}>
    © {new Date().getFullYear()} Abdul Fuseini | <a href="https://abdulwfuseini.github.io/" target="_blank" rel="noopener noreferrer" style={{ color: '#4DA8DA', textDecoration: 'none' }}>abdulwfuseini.github.io</a>
</footer>



    </div>

    
  );
};

export default VehicleMap;
