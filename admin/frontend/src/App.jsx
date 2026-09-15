import { useState, useEffect } from 'react';
import { Activity, Users, Server, HardDrive, Search, Shield, RefreshCw, UserPlus, UserMinus, Folder, Download, Plus, Edit2, Moon, Sun } from 'lucide-react';

function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

// Cuando expira la sesion, Flask responde 302 a /login. fetch sigue el redirect
// y devuelve el HTML del login con status 200, con lo cual res.json() explota y
// la UI se queda mostrando datos viejos sin avisar nada. Detectamos ese caso y
// mandamos al login.
async function apiFetch(url, options) {
  const res = await fetch(url, options);
  if (res.redirected && new URL(res.url).pathname === '/login') {
    window.location.href = '/login';
    throw new Error('session_expired');
  }
  return res;
}

export default function App() {
  const [stats, setStats] = useState({ connected: 0, total: 0, groups: 0, modernRatio: '' });
  const [connectedClients, setConnectedClients] = useState([]);
  const [allClients, setAllClients] = useState([]);
  const [groupsDict, setGroupsDict] = useState({});
  const [searchQuery, setSearchQuery] = useState('');
  const [clientsSearchQuery, setClientsSearchQuery] = useState('');
  const [groupsSearchQuery, setGroupsSearchQuery] = useState('');
  
  // Pagination state
  const [pageActive, setPageActive] = useState(1);
  const [pageClients, setPageClients] = useState(1);
  const [pageGroups, setPageGroups] = useState(1);
  const ITEMS_PER_PAGE = 20;

  const [loading, setLoading] = useState(true);
  
  // Group modal state
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null); // null for new, {id, name, icon} for edit
  const [groupFormData, setGroupFormData] = useState({ name: '', icon: '' });
  
  // Navigation state
  const [activeTab, setActiveTab] = useState('dashboard');
  
  // Theme state
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('wedo-theme');
    return saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches);
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('wedo-theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('wedo-theme', 'light');
    }
  }, [darkMode]);

  const fetchStats = async () => {
    try {
      const [connRes, clientsRes, groupsRes] = await Promise.all([
        apiFetch('/api/connected'),
        apiFetch('/api/clients'),
        apiFetch('/api/groups')
      ]);
      const connData = await connRes.json();
      const clientsData = await clientsRes.json();
      const groupsData = await groupsRes.json();
      
      const modernCount = clientsData.clients.filter(c => c.daemon === "modern").length;
      
      setStats({
        connected: connData.clients.length,
        total: clientsData.clients.length,
        groups: Object.keys(groupsData.groups).length,
        modernRatio: `${modernCount}/${clientsData.clients.length}`
      });
      setConnectedClients(connData.clients);
      setAllClients(clientsData.clients);
      setGroupsDict(groupsData.groups);
    } catch (err) {
      console.error("Error fetching data:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, []);

  const filteredConnections = connectedClients.filter(c => 
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    c.real_ip.includes(searchQuery)
  );

  const handleGroupSubmit = async (e) => {
    e.preventDefault();
    const url = editingGroup ? `/api/groups/${editingGroup.id}` : '/api/groups';
    const method = editingGroup ? 'PUT' : 'POST';
    
    try {
      const res = await apiFetch(url, {
        method,
        headers: { 
          'Content-Type': 'application/json',
          'X-CSRFToken': getCsrfToken()
        },
        body: JSON.stringify(groupFormData)
      });
      const data = await res.json();
      if (data.success) {
        setShowGroupModal(false);
        fetchStats(); // recargar
      } else {
        alert("Error: " + data.error);
      }
    } catch (err) {
      alert("Error de conexión");
    }
  };

  const filteredAllClients = allClients.filter(c => {
    const term = clientsSearchQuery.toLowerCase();
    return c.name.toLowerCase().includes(term) || 
           (c.ip && c.ip.includes(term)) ||
           (groupsDict[c.group] && groupsDict[c.group].name.toLowerCase().includes(term));
  });

  const filteredGroups = Object.entries(groupsDict).filter(([id, g]) => {
    const term = groupsSearchQuery.toLowerCase();
    return id.toLowerCase().includes(term) || 
           g.name.toLowerCase().includes(term) || 
           g.icon.toLowerCase().includes(term);
  });

  return (
    <div className="min-h-screen bg-wedo-bg text-slate-800 flex flex-col font-sans">
      {/* Topbar */}
      <header className="bg-wedo-dark border-b border-wedo-dark px-6 py-4 flex items-center justify-between shadow-sm z-10 sticky top-0">
        <div className="flex items-center gap-2">
          <img src="/static/img/wedo-logo.png" alt="WeDo" className="h-6 object-contain" onError={(e) => e.target.style.display = 'none'} />
          <span className="text-wedo-orange font-bold text-xl tracking-wide">VPN</span>
        </div>
        <div className="flex items-center gap-4">
          <button 
            onClick={() => setDarkMode(!darkMode)}
            className="p-2 text-wedo-text hover:text-white bg-slate-800 rounded-lg transition-colors border border-slate-700"
            title="Alternar tema oscuro/claro"
          >
            {darkMode ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <a 
            href="/logout"
            className="text-sm font-medium text-wedo-text hover:text-white transition-colors"
          >
            Cerrar sesión
          </a>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 bg-white border-r border-wedo-border hidden md:flex flex-col shadow-sm">
          <nav className="flex-1 py-6 px-4 flex flex-col gap-2">
            <NavItem 
              icon={<Activity size={20} />} 
              label="Conexiones Activas" 
              isActive={activeTab === 'dashboard'} 
              onClick={() => setActiveTab('dashboard')} 
            />
            <NavItem 
              icon={<Users size={20} />} 
              label="Todos los Clientes" 
              isActive={activeTab === 'clientes'} 
              onClick={() => setActiveTab('clientes')} 
            />
            
            <div className="mt-8 mb-2 px-3 text-xs font-bold text-slate-400 uppercase tracking-wider">
              Acciones
            </div>
            
            <NavItem 
              icon={<Folder size={20} />} 
              label="Gestión de Grupos" 
              isActive={activeTab === 'grupos'} 
              onClick={() => setActiveTab('grupos')} 
            />
            <NavItem 
              icon={<UserPlus size={20} />} 
              label="Nuevo Cliente" 
              isActive={activeTab === 'nuevo'} 
              onClick={() => setActiveTab('nuevo')} 
            />
            <NavItem 
              icon={<UserMinus size={20} />} 
              label="Revocar Cliente" 
              isActive={activeTab === 'revocar'} 
              onClick={() => setActiveTab('revocar')} 
              isDanger
            />
          </nav>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto p-6 md:p-8">
          <div className="max-w-6xl mx-auto w-full flex flex-col gap-6">
            
            {/* Solo mostramos los stats en el Dashboard */}
            {activeTab === 'dashboard' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-2">
                <StatCard title="Conectados" value={loading ? '...' : stats.connected} icon={<Activity className="text-wedo-success" />} />
                <StatCard title="Clientes Totales" value={loading ? '...' : stats.total} icon={<Users className="text-wedo-orange" />} />
                <StatCard title="Grupos Activos" value={loading ? '...' : stats.groups} icon={<HardDrive className="text-wedo-orange" />} />
                <StatCard title="Modern / Total" value={loading ? '...' : stats.modernRatio} icon={<Server className="text-teal-600" />} />
              </div>
            )}

            {/* Vistas Dinámicas */}
            {activeTab === 'dashboard' && (
              <div className="bg-wedo-card border-l-4 border-l-wedo-orange rounded-lg overflow-hidden flex flex-col" style={{ boxShadow: '0 2px 8px rgba(0,0,0,.06)' }}>
                <div className="px-6 py-5 border-b border-wedo-border flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white">
                  <div className="flex items-center gap-3">
                    <h2 className="text-lg font-bold text-slate-800 uppercase tracking-wide">
                      Conexiones Activas
                    </h2>
                    <span className="bg-wedo-success/10 text-wedo-success text-xs px-2.5 py-1 rounded-full font-bold uppercase">
                      {stats.connected} Live
                    </span>
                  </div>
                  
                  <div className="flex items-center gap-3 w-full sm:w-auto">
                    <div className="relative w-full sm:w-64">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-wedo-text" size={16} />
                      <input 
                        type="text" 
                        placeholder="Buscá cliente o IP..." 
                        className="w-full bg-wedo-bg border border-wedo-border rounded-md pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-wedo-orange focus:border-wedo-orange transition-shadow"
                        value={searchQuery}
                        onChange={(e) => {
                          setSearchQuery(e.target.value);
                          setPageActive(1);
                        }}
                      />
                    </div>
                    <button 
                      onClick={fetchStats} 
                      className="p-2 border border-wedo-border rounded-md hover:bg-wedo-bg text-wedo-text transition-colors"
                      title="Actualizar"
                    >
                      <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                    </button>
                  </div>
                </div>
                
                <div className="overflow-x-auto bg-white">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-wedo-bg text-wedo-text text-xs font-bold uppercase tracking-wider">
                        <th className="px-6 py-4">Cliente</th>
                        <th className="px-6 py-4">Grupo</th>
                        <th className="px-6 py-4">IP VPN</th>
                        <th className="px-6 py-4">IP Real</th>
                        <th className="px-6 py-4">Daemon</th>
                        <th className="px-6 py-4">Conectado desde</th>
                        <th className="px-6 py-4">Tráfico</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-wedo-border">
                      {loading ? (
                        <tr>
                          <td colSpan="7" className="px-6 py-12 text-center text-wedo-text font-medium">
                            Cargando conexiones...
                          </td>
                        </tr>
                      ) : filteredConnections.length > 0 ? (
                        filteredConnections.slice((pageActive - 1) * ITEMS_PER_PAGE, pageActive * ITEMS_PER_PAGE).map((client, i) => (
                          <tr key={i} className="hover:bg-slate-50 transition-colors">
                            <td className="px-6 py-4 whitespace-nowrap font-bold text-slate-800">{client.name}</td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold bg-wedo-bg text-slate-700 border border-wedo-border">
                                {client.group_icon} {client.group_name}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap font-mono text-sm text-wedo-orange">
                              {client.vpn_ip ? (
                                <a href={`http://${client.vpn_ip}`} target="_blank" rel="noreferrer" className="hover:underline">
                                  {client.vpn_ip}
                                </a>
                              ) : 'Dinámica'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap font-mono text-sm text-slate-500">{client.real_ip}</td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold uppercase ${client.daemon === 'modern' ? 'bg-teal-100 text-teal-700' : 'bg-slate-200 text-slate-700'}`}>
                                {client.daemon === 'modern' ? 'modern' : 'classic'}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-600">{client.connected_since}</td>
                            <td className="px-6 py-4 whitespace-nowrap text-xs font-mono font-medium">
                              <div className="flex flex-col gap-1">
                                <span className="text-wedo-success">↓ {client.bytes_recv}</span>
                                <span className="text-wedo-orange">↑ {client.bytes_sent}</span>
                              </div>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan="7" className="px-6 py-12 text-center text-wedo-text font-medium">
                            {searchQuery ? 'No se encontraron clientes para tu búsqueda.' : 'No hay conexiones activas en este momento.'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <Pagination 
                  currentPage={pageActive} 
                  totalPages={Math.ceil(filteredConnections.length / ITEMS_PER_PAGE)} 
                  onPageChange={setPageActive} 
                />
              </div>
            )}
            
            {activeTab === 'clientes' && (
              <div className="bg-wedo-card border-l-4 border-l-wedo-orange rounded-lg overflow-hidden flex flex-col" style={{ boxShadow: '0 2px 8px rgba(0,0,0,.06)' }}>
                <div className="px-6 py-5 border-b border-wedo-border flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white">
                  <div className="flex items-center gap-3">
                    <h2 className="text-lg font-bold text-slate-800 uppercase tracking-wide">
                      Todos los Clientes
                    </h2>
                    <span className="bg-wedo-orange/10 text-wedo-orange text-xs px-2.5 py-1 rounded-full font-bold uppercase">
                      {allClients.length} Registrados
                    </span>
                  </div>
                  
                  <div className="flex items-center gap-3 w-full sm:w-auto">
                    <div className="relative w-full sm:w-64">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-wedo-text" size={16} />
                      <input 
                        type="text" 
                        placeholder="Buscar por nombre, grupo o IP..." 
                        className="w-full bg-wedo-bg border border-wedo-border rounded-md pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-wedo-orange focus:border-wedo-orange transition-shadow"
                        value={clientsSearchQuery}
                        onChange={(e) => setClientsSearchQuery(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
                
                <div className="overflow-x-auto bg-white">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-wedo-bg text-wedo-text text-xs font-bold uppercase tracking-wider">
                        <th className="px-6 py-4">Estado</th>
                        <th className="px-6 py-4">Cliente</th>
                        <th className="px-6 py-4">Grupo</th>
                        <th className="px-6 py-4">IP Asignada</th>
                        <th className="px-6 py-4">Modelo</th>
                        <th className="px-6 py-4">Daemon</th>
                        <th className="px-6 py-4 text-right">Descargar</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-wedo-border">
                      {loading ? (
                        <tr>
                          <td colSpan="7" className="px-6 py-12 text-center text-wedo-text font-medium">
                            Cargando clientes...
                          </td>
                        </tr>
                      ) : filteredAllClients.length > 0 ? (
                        filteredAllClients.slice((pageClients - 1) * ITEMS_PER_PAGE, pageClients * ITEMS_PER_PAGE).map((client, i) => {
                          const group = groupsDict[client.group] || {};
                          const isOnline = connectedClients.some(c => c.name === client.name);
                          
                          return (
                            <tr key={i} className="hover:bg-slate-50 transition-colors">
                              <td className="px-6 py-4 whitespace-nowrap">
                                {isOnline ? (
                                  <span className="flex items-center gap-1.5 text-wedo-success text-xs font-bold uppercase">
                                    <span className="w-2 h-2 rounded-full bg-wedo-success animate-pulse"></span>
                                    Online
                                  </span>
                                ) : (
                                  <span className="flex items-center gap-1.5 text-slate-400 text-xs font-bold uppercase">
                                    <span className="w-2 h-2 rounded-full bg-slate-300"></span>
                                    Offline
                                  </span>
                                )}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap font-bold text-slate-800">{client.name}</td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold bg-wedo-bg text-slate-700 border border-wedo-border">
                                  {group.icon || '-'} {group.name || 'Sin Grupo'}
                                </span>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap font-mono text-sm text-slate-600">
                                {client.ip || 'Dinámica'}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">
                                  {client.model || 'Desconocido'}
                                </span>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold uppercase ${client.daemon === 'modern' ? 'bg-teal-100 text-teal-700' : 'bg-slate-200 text-slate-700'}`}>
                                  {client.daemon === 'modern' ? 'modern' : 'classic'}
                                </span>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-right">
                                <a 
                                  href={`/download/${encodeURIComponent(client.name)}`}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-wedo-orange hover:bg-wedo-orange/90 text-white rounded text-sm font-medium transition-colors"
                                >
                                  <Download size={14} />
                                  .ovpn
                                </a>
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan="7" className="px-6 py-12 text-center text-wedo-text font-medium">
                            {clientsSearchQuery ? 'No se encontraron clientes para tu búsqueda.' : 'No hay clientes registrados en el sistema.'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <Pagination 
                  currentPage={pageClients} 
                  totalPages={Math.ceil(filteredAllClients.length / ITEMS_PER_PAGE)} 
                  onPageChange={setPageClients} 
                />
              </div>
            )}

            {activeTab === 'grupos' && (
              <div className="flex flex-col gap-6">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                  <div>
                    <h2 className="text-xl font-bold text-slate-800">Gestión de Grupos</h2>
                    <p className="text-sm text-slate-500">Crea o edita los grupos de la VPN. Los grupos proveen aislamiento de red.</p>
                  </div>
                  <div className="flex items-center gap-3 w-full sm:w-auto">
                    <div className="relative w-full sm:w-64">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                      <input 
                        type="text" 
                        placeholder="Buscar grupo..." 
                        className="w-full bg-white border border-wedo-border rounded-lg pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-wedo-orange focus:border-transparent transition-shadow shadow-sm"
                        value={groupsSearchQuery}
                        onChange={(e) => setGroupsSearchQuery(e.target.value)}
                      />
                    </div>
                    <button 
                      onClick={() => {
                        setEditingGroup(null);
                        setGroupFormData({ name: '', icon: '' });
                        setShowGroupModal(true);
                      }}
                      className="flex items-center gap-2 bg-wedo-orange hover:bg-orange-600 text-white px-4 py-2 rounded-lg font-bold text-sm shadow-sm transition-colors whitespace-nowrap"
                    >
                      <Plus size={18} />
                      Nuevo Grupo
                    </button>
                  </div>
                </div>

                <div className="bg-wedo-card border-l-4 border-l-wedo-orange rounded-lg overflow-hidden flex flex-col" style={{ boxShadow: '0 2px 8px rgba(0,0,0,.06)' }}>
                  <div className="overflow-x-auto bg-white">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-wedo-bg text-wedo-text text-xs font-bold uppercase tracking-wider">
                          <th className="px-6 py-4">ID</th>
                          <th className="px-6 py-4">Nombre de Grupo</th>
                          <th className="px-6 py-4">Capacidad</th>
                          <th className="px-6 py-4">Redes Reservadas</th>
                          <th className="px-6 py-4 text-right">Acciones</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-wedo-border">
                        {filteredGroups.slice((pageGroups - 1) * ITEMS_PER_PAGE, pageGroups * ITEMS_PER_PAGE).map(([id, g]) => {
                          const isAdmin = g.is_system || g.can_see_all;
                          const total = g.capacity || 254;
                          const used = g.client_count || 0;
                          
                          return (
                            <tr key={id} className="hover:bg-slate-50 transition-colors">
                              <td className="px-6 py-4 whitespace-nowrap font-mono text-sm text-slate-500">
                                {id}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="flex items-center gap-3">
                                  <div className="w-8 h-8 rounded bg-slate-100 flex items-center justify-center text-xs font-bold text-slate-700 shrink-0">
                                    {g.icon}
                                  </div>
                                  <div className="flex flex-col">
                                    <span className="font-bold text-slate-800">{g.name}</span>
                                    {isAdmin && <span className="text-[10px] font-bold text-wedo-orange uppercase tracking-wider">Admin System</span>}
                                  </div>
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="flex flex-col gap-1 w-32">
                                  <div className="flex justify-between items-center">
                                    <span className="text-xs font-bold text-slate-700">{used} / {total}</span>
                                    <span className="text-[10px] font-bold text-slate-400 uppercase">{Math.round((used/total)*100)}%</span>
                                  </div>
                                  <div className="w-full bg-slate-200 rounded-full h-1.5">
                                    <div className="bg-wedo-orange h-1.5 rounded-full" style={{ width: `${Math.min(100, (used/total)*100)}%` }}></div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="flex flex-col gap-1">
                                  {g.classic_count > 0 && (
                                    <div className="flex items-center gap-2 text-xs">
                                      <span className="bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded font-bold uppercase text-[10px]">Classic</span>
                                      <span className="text-slate-600 font-mono">{g.classic_start} - {g.classic_end?.split('.').pop()}</span>
                                    </div>
                                  )}
                                  {g.modern_count > 0 && (
                                    <div className="flex items-center gap-2 text-xs">
                                      <span className="bg-teal-100 text-teal-700 px-1.5 py-0.5 rounded font-bold uppercase text-[10px]">Modern</span>
                                      <span className="text-slate-600 font-mono">{g.modern_start} - {g.modern_end?.split('.').pop()}</span>
                                    </div>
                                  )}
                                  {(g.classic_count === 0 && g.modern_count === 0) && (
                                    <span className="text-xs text-slate-400 italic">Sin clientes activos</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-right">
                                {!isAdmin ? (
                                  <button 
                                    onClick={() => {
                                      setEditingGroup({ id, ...g });
                                      setGroupFormData({ name: g.name, icon: g.icon });
                                      setShowGroupModal(true);
                                    }}
                                    className="p-1.5 text-slate-400 hover:text-wedo-orange hover:bg-orange-50 rounded-md transition-colors"
                                    title="Editar Grupo"
                                  >
                                    <Edit2 size={16} />
                                  </button>
                                ) : (
                                  <Shield size={16} className="text-slate-300 inline-block" title="Grupo del Sistema" />
                                )}
                              </td>
                            </tr>
                          );
                        })}
                        
                        {Object.keys(groupsDict).length === 0 && !loading && (
                          <tr>
                            <td colSpan="5" className="px-6 py-12 text-center text-wedo-text font-medium">
                              No hay grupos creados.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                </div>
                <Pagination 
                  currentPage={pageGroups} 
                  totalPages={Math.ceil(filteredGroups.length / ITEMS_PER_PAGE)} 
                  onPageChange={setPageGroups} 
                />
              </div>
              </div>
            )}

            {activeTab === 'nuevo' && (
              <NewClientForm 
                groupsDict={groupsDict} 
                onSuccess={() => fetchStats()} 
              />
            )}

            {activeTab === 'revocar' && (
              <RevokeClientForm 
                allClients={allClients}
                onSuccess={() => fetchStats()}
              />
            )}

          </div>
        </main>
      </div>
      
      {/* Modal de Grupos */}
      {showGroupModal && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md overflow-hidden flex flex-col">
            <div className="bg-wedo-dark px-6 py-4 border-b border-slate-700 flex justify-between items-center">
              <h2 className="text-lg font-bold text-white">
                {editingGroup ? 'Editar Grupo' : 'Nuevo Grupo'}
              </h2>
              {editingGroup && <span className="text-slate-400 text-sm font-mono">{editingGroup.id}</span>}
            </div>
            
            <form onSubmit={handleGroupSubmit} className="p-6 flex flex-col gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">
                  Nombre del Grupo
                </label>
                <input 
                  type="text" 
                  required
                  value={groupFormData.name}
                  onChange={e => setGroupFormData({...groupFormData, name: e.target.value})}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-wedo-orange focus:border-transparent transition-shadow"
                  placeholder="Ej: Contabilidad"
                />
              </div>
              
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">
                  Abreviatura (Ícono)
                </label>
                <input 
                  type="text" 
                  required
                  maxLength={2}
                  value={groupFormData.icon}
                  onChange={e => setGroupFormData({...groupFormData, icon: e.target.value.toUpperCase()})}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-wedo-orange focus:border-transparent transition-shadow uppercase"
                  placeholder="CO"
                />
                <p className="text-xs text-slate-500 mt-1.5">Dos letras en mayúscula para identificar el grupo (ej: CO).</p>
              </div>

              <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-slate-100">
                <button 
                  type="button" 
                  onClick={() => setShowGroupModal(false)}
                  className="px-4 py-2 text-sm font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-50 rounded-lg transition-colors"
                >
                  Cancelar
                </button>
                <button 
                  type="submit" 
                  className="px-5 py-2 text-sm font-bold text-white bg-wedo-orange hover:bg-orange-600 rounded-lg transition-colors shadow-sm"
                >
                  Guardar Grupo
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function NavItem({ icon, label, isActive, onClick, isDanger }) {
  const activeClasses = isActive 
    ? 'bg-wedo-bg text-wedo-orange font-bold border-r-4 border-wedo-orange' 
    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900 font-medium';
  
  const dangerClasses = isDanger && isActive
    ? 'bg-red-50 text-red-600 font-bold border-r-4 border-red-500'
    : isDanger && !isActive
    ? 'text-red-500 hover:bg-red-50 font-medium'
    : '';

  return (
    <button 
      onClick={onClick}
      className={`flex items-center gap-3 px-4 py-3 rounded-l-lg transition-colors text-left ${isDanger ? dangerClasses : activeClasses}`}
    >
      {icon}
      <span className="text-sm">{label}</span>
    </button>
  );
}

function StatCard({ title, value, icon }) {
  return (
    <div className="bg-wedo-card border border-wedo-border rounded-lg p-5 flex items-center justify-between" style={{ boxShadow: '0 2px 8px rgba(0,0,0,.04)' }}>
      <div>
        <p className="text-xs font-bold text-wedo-text uppercase tracking-wider mb-1">{title}</p>
        <p className="text-2xl font-bold text-slate-800">{value}</p>
      </div>
      <div className="p-3 bg-wedo-bg rounded-lg">
        {icon}
      </div>
    </div>
  );
}

function Pagination({ currentPage, totalPages, onPageChange }) {
  if (totalPages <= 1) return null;
  
  return (
    <div className="flex items-center justify-between px-6 py-3 border-t border-wedo-border bg-slate-50 dark:bg-slate-800/50">
      <span className="text-xs text-slate-500">
        Página {currentPage} de {totalPages}
      </span>
      <div className="flex gap-2">
        <button 
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className="px-3 py-1 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 disabled:opacity-50 transition-colors hover:bg-slate-50 dark:hover:bg-slate-700"
        >
          Anterior
        </button>
        <button 
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className="px-3 py-1 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 disabled:opacity-50 transition-colors hover:bg-slate-50 dark:hover:bg-slate-700"
        >
          Siguiente
        </button>
      </div>
    </div>
  );
}

function NewClientForm({ groupsDict, onSuccess }) {
  const [formData, setFormData] = useState({ name: '', group: '', model: 'UG67' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { success: bool, message: string, ip?: string, name?: string }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setResult(null);

    try {
      const res = await apiFetch('/api/create', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-CSRFToken': getCsrfToken()
        },
        body: JSON.stringify(formData)
      });
      const data = await res.json();
      
      if (data.success) {
        setResult({
          success: true,
          message: '¡Cliente creado exitosamente!',
          ip: data.ip,
          name: data.name
        });
        setFormData({ name: '', group: '', model: 'UG67' });
        if (onSuccess) onSuccess();
      } else {
        setResult({ success: false, message: data.error || 'Error desconocido' });
      }
    } catch (err) {
      setResult({ success: false, message: 'Error de conexión con el servidor.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const isModern = formData.model === 'UG63v2' || formData.model === 'Other';
  const daemonText = isModern ? 'modern' : 'classic';
  const daemonDesc = isModern ? 'puerto 1195, subred 10.9.x.x' : 'puerto 1194, subred 10.8.x.x';
  const badgeClass = isModern ? 'bg-teal-100 text-teal-700' : 'bg-slate-200 text-slate-700';

  return (
    <div className="max-w-2xl mx-auto w-full">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-slate-800">Nuevo Cliente</h2>
        <p className="text-sm text-slate-500">Registra un nuevo dispositivo en la VPN y genera su certificado.</p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-wedo-border overflow-hidden">
        <form onSubmit={handleSubmit} className="p-6 md:p-8 flex flex-col gap-6">
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                Nombre del Cliente
              </label>
              <input 
                type="text" 
                required
                value={formData.name}
                onChange={e => setFormData({...formData, name: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '')})}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-wedo-orange focus:border-transparent transition-shadow"
                placeholder="Ej: cliente_rosario_01"
              />
              <span className="text-xs text-slate-400">Sin espacios, letras o números o _ -</span>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                Grupo
              </label>
              <select 
                required
                value={formData.group}
                onChange={e => setFormData({...formData, group: e.target.value})}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-wedo-orange focus:border-transparent transition-shadow"
              >
                <option value="" disabled>- Seleccionar grupo -</option>
                {Object.entries(groupsDict).map(([id, g]) => (
                  <option key={id} value={id}>{g.name} ({id})</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-2 pt-2">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Modelo del Equipo
            </label>
            <select 
              required
              value={formData.model}
              onChange={e => setFormData({...formData, model: e.target.value})}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-wedo-orange focus:border-transparent transition-shadow max-w-sm"
            >
              <option value="UG67">Milesight UG67</option>
              <option value="UG65">Milesight UG65</option>
              <option value="UG56">Milesight UG56</option>
              <option value="UG63v2">Milesight UG63v2</option>
              <option value="Desktop">Desktop / laptop</option>
              <option value="Other">Otro</option>
            </select>
            <div className="mt-2 text-sm text-slate-600 flex items-center gap-2">
              Daemon asignado: <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${badgeClass}`}>{daemonText}</span>
              <span className="text-slate-400">({daemonDesc})</span>
            </div>
          </div>

          <div className="mt-4 pt-6 border-t border-slate-100 flex items-center justify-between">
            <div>
              {result && (
                <div className={`text-sm font-medium ${result.success ? 'text-wedo-success' : 'text-wedo-danger'}`}>
                  {result.message}
                </div>
              )}
            </div>
            
            <button 
              type="submit" 
              disabled={isSubmitting}
              className="flex items-center gap-2 bg-wedo-orange hover:bg-orange-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded-lg font-bold text-sm shadow-sm transition-colors"
            >
              {isSubmitting ? (
                <>
                  <RefreshCw size={18} className="animate-spin" />
                  Creando...
                </>
              ) : (
                <>
                  <UserPlus size={18} />
                  Crear Cliente
                </>
              )}
            </button>
          </div>
        </form>
        
        {/* Success Banner Overlay */}
        {result && result.success && (
          <div className="bg-wedo-success/10 border-t border-wedo-success p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div>
              <p className="text-wedo-success font-bold flex items-center gap-2">
                <Shield size={20} />
                ¡Certificado Generado!
              </p>
              <p className="text-sm text-slate-600 mt-1">
                La IP asignada es: <strong className="font-mono bg-white px-1.5 py-0.5 rounded border border-slate-200">{result.ip}</strong>
              </p>
            </div>
            <a 
              href={`/download/${encodeURIComponent(result.name)}`}
              className="flex items-center gap-2 bg-wedo-success hover:bg-green-600 text-white px-5 py-2.5 rounded-lg font-bold text-sm shadow-sm transition-colors whitespace-nowrap"
            >
              <Download size={18} />
              Descargar .ovpn
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function RevokeClientForm({ allClients, onSuccess }) {
  const [clientName, setClientName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!clientName) return;
    
    if (!confirm(`¿Estás SEGURO de revocar al cliente '${clientName}'?\n\nEsta acción es IRREVERSIBLE.\n\nAl confirmar, OpenVPN se reiniciará y las conexiones activas se desconectarán momentáneamente.`)) {
      return;
    }
    
    setIsSubmitting(true);
    setResult(null);

    try {
      const res = await apiFetch('/api/revoke', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-CSRFToken': getCsrfToken()
        },
        body: JSON.stringify({ name: clientName })
      });
      const data = await res.json();
      
      if (data.success) {
        setResult({ success: true, message: 'Cliente revocado correctamente. Las conexiones se han restablecido.' });
        setClientName('');
        if (onSuccess) onSuccess();
      } else {
        setResult({ success: false, message: data.error || 'Error desconocido al revocar' });
      }
    } catch (err) {
      setResult({ success: false, message: 'Error de conexión con el servidor.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto w-full">
      <div className="mb-6">
        <h2 className="text-xl font-bold text-slate-800">Revocar Cliente</h2>
        <p className="text-sm text-slate-500">Elimina el acceso de un cliente a la VPN permanentemente.</p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-red-200 overflow-hidden relative">
        <div className="absolute top-0 left-0 w-full h-1 bg-wedo-danger"></div>
        
        <form onSubmit={handleSubmit} className="p-6 md:p-8 flex flex-col gap-6">
          
          <div className="bg-red-50 text-red-800 p-4 rounded-lg flex gap-3 text-sm border border-red-100">
            <Shield className="shrink-0 text-wedo-danger" size={20} />
            <div>
              <p className="font-bold mb-1">¡Advertencia! Acción Irreversible</p>
              <p>Al revocar un certificado, este perderá acceso instantáneamente y no podrá volver a conectarse. <strong>El servicio VPN se reiniciará</strong> y todos los clientes conectados experimentarán una desconexión de ~3 segundos.</p>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Seleccionar Cliente a Revocar
            </label>
            
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input 
                type="text" 
                required
                list="clients-list"
                value={clientName}
                onChange={e => setClientName(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-10 pr-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-wedo-danger focus:border-transparent transition-shadow"
                placeholder="Escribe el nombre del cliente..."
              />
              <datalist id="clients-list">
                {allClients.map(c => (
                  <option key={c.name} value={c.name} />
                ))}
              </datalist>
            </div>
            <span className="text-xs text-slate-400">Busca y selecciona el nombre exacto del cliente que deseas dar de baja.</span>
          </div>

          <div className="mt-4 pt-6 border-t border-slate-100 flex items-center justify-between">
            <div>
              {result && (
                <div className={`text-sm font-medium ${result.success ? 'text-wedo-success' : 'text-wedo-danger'}`}>
                  {result.message}
                </div>
              )}
            </div>
            
            <button 
              type="submit" 
              disabled={isSubmitting || !clientName}
              className="flex items-center gap-2 bg-wedo-danger hover:bg-red-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded-lg font-bold text-sm shadow-sm transition-colors"
            >
              {isSubmitting ? (
                <>
                  <RefreshCw size={18} className="animate-spin" />
                  Revocando...
                </>
              ) : (
                <>
                  <UserMinus size={18} />
                  Revocar Cliente
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
