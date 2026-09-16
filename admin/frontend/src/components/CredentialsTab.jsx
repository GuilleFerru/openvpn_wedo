import React, { useState, useEffect } from 'react';
import { Key, Plus, Search, Edit2, Trash2, Copy, Eye, EyeOff, Save, X, ChevronUp, ChevronDown } from 'lucide-react';
import { apiFetch, getCsrfToken } from '../App';

export default function CredentialsTab({ allClients, groupsDict }) {
  const [credentials, setCredentials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Sort state
  const [sortField, setSortField] = useState('group_name');
  const [sortOrder, setSortOrder] = useState('asc');
  
  const [showModal, setShowModal] = useState(false);
  const [editingCred, setEditingCred] = useState(null);
  
  // Modal form state
  const [clientName, setClientName] = useState('');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  
  // For showing/hiding passwords in the list
  const [visiblePasswords, setVisiblePasswords] = useState({});

  useEffect(() => {
    fetchCredentials();
  }, []);

  const fetchCredentials = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/credentials');
      const data = await res.json();
      if (data.success) {
        setCredentials(data.credentials);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSort = (field) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <span className="w-3" />;
    return sortOrder === 'asc' ? <ChevronUp size={14} className="ml-1" /> : <ChevronDown size={14} className="ml-1" />;
  };

  const credentialsWithGroup = credentials.map(cred => {
    const client = allClients.find(c => c.name === cred.client_name);
    const group = client && groupsDict && groupsDict[client.group] ? groupsDict[client.group] : {};
    return {
      ...cred,
      group_name: group.name || 'Sin Grupo',
      group_icon: group.icon || '-'
    };
  });

  const filteredCredentials = credentialsWithGroup.filter(c => {
    const q = searchQuery.toLowerCase();
    return c.client_name.toLowerCase().includes(q) || 
           c.group_name.toLowerCase().includes(q) ||
           c.url.toLowerCase().includes(q) ||
           c.username.toLowerCase().includes(q);
  }).sort((a, b) => {
    let valA = sortField === 'group_name' ? a.group_name.toLowerCase() : a.client_name.toLowerCase();
    let valB = sortField === 'group_name' ? b.group_name.toLowerCase() : b.client_name.toLowerCase();
    
    // Fallback to client_name if groups are identical
    if (valA === valB) {
      valA = a.client_name.toLowerCase();
      valB = b.client_name.toLowerCase();
    }
    
    if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
    if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
    return 0;
  });

  const togglePasswordVisibility = (clientName) => {
    setVisiblePasswords(prev => ({
      ...prev,
      [clientName]: !prev[clientName]
    }));
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  const openAddModal = () => {
    setEditingCred(null);
    setClientName('');
    setUrl('');
    setUsername('');
    setPassword('');
    setNotes('');
    setErrorMsg('');
    setShowModal(true);
  };

  const openEditModal = (cred) => {
    setEditingCred(cred.client_name);
    setClientName(cred.client_name);
    setUrl(cred.url);
    setUsername(cred.username);
    setPassword(cred.password);
    setNotes(cred.notes);
    setErrorMsg('');
    setShowModal(true);
  };

  const handleDelete = async (clientName) => {
    if (!confirm(`¿Estás seguro de eliminar las credenciales para el cliente ${clientName}?`)) return;
    
    try {
      const res = await apiFetch(`/api/credentials/${encodeURIComponent(clientName)}`, {
        method: 'DELETE',
        headers: {
          'X-CSRFToken': getCsrfToken()
        }
      });
      const data = await res.json();
      if (data.success) {
        fetchCredentials();
      } else {
        alert("Error al eliminar: " + data.error);
      }
    } catch (err) {
      alert("Error de conexión");
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!clientName) {
      setErrorMsg('Debes seleccionar un cliente.');
      return;
    }
    
    setIsSubmitting(true);
    setErrorMsg('');
    
    try {
      const res = await apiFetch(`/api/credentials/${encodeURIComponent(clientName)}`, {
        method: editingCred ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': getCsrfToken()
        },
        body: JSON.stringify({
          url,
          username,
          password,
          notes
        })
      });
      
      const data = await res.json();
      if (data.success) {
        setShowModal(false);
        fetchCredentials();
      } else {
        setErrorMsg(data.error || 'Error al guardar las credenciales');
      }
    } catch (err) {
      setErrorMsg('Error de conexión');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <Key className="text-wedo-orange" /> Gestión de Accesos
          </h2>
          <p className="text-slate-500 text-sm mt-1">Almacena de forma segura las credenciales de los clientes.</p>
        </div>
        <button 
          onClick={openAddModal}
          className="flex items-center gap-2 px-4 py-2 bg-wedo-orange hover:bg-wedo-orange/90 text-white rounded-lg font-medium transition-colors shadow-sm"
        >
          <Plus size={18} /> Nueva Credencial
        </button>
      </div>

      <div className="bg-wedo-card border-l-4 border-l-wedo-orange rounded-lg overflow-hidden flex flex-col" style={{ boxShadow: '0 2px 8px rgba(0,0,0,.06)' }}>
        <div className="px-6 py-5 border-b border-wedo-border flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-slate-800 uppercase tracking-wide">
              Credenciales Guardadas
            </h2>
            <span className="bg-wedo-orange/10 text-wedo-orange text-xs px-2.5 py-1 rounded-full font-bold uppercase">
              {credentials.length} Registros
            </span>
          </div>
          
          <div className="flex items-center gap-3 w-full sm:w-auto">
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-wedo-text" size={16} />
              <input 
                type="text" 
                placeholder="Buscar por cliente, grupo o usuario..." 
                className="w-full bg-wedo-bg border border-wedo-border rounded-md pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-wedo-orange transition-shadow"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>
        </div>
        
        <div className="overflow-x-auto bg-white">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-wedo-bg text-wedo-text text-xs font-bold uppercase tracking-wider">
                <th className="px-6 py-4 cursor-pointer hover:text-wedo-orange transition-colors" onClick={() => handleSort('group_name')}>
                  <div className="flex items-center">Grupo <SortIcon field="group_name" /></div>
                </th>
                <th className="px-6 py-4 cursor-pointer hover:text-wedo-orange transition-colors" onClick={() => handleSort('client_name')}>
                  <div className="flex items-center">Cliente <SortIcon field="client_name" /></div>
                </th>
                <th className="px-6 py-4">URL / IP</th>
                <th className="px-6 py-4">Usuario</th>
                <th className="px-6 py-4">Contraseña</th>
                <th className="px-6 py-4 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-wedo-border">
              {loading ? (
                <tr>
                  <td colSpan="6" className="px-6 py-12 text-center text-wedo-text font-medium">
                    Cargando credenciales...
                  </td>
                </tr>
              ) : filteredCredentials.length > 0 ? (
                filteredCredentials.map((cred, i) => (
                  <tr key={i} className="hover:bg-slate-50 transition-colors group">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold bg-wedo-bg text-slate-700 border border-wedo-border">
                        {cred.group_icon} {cred.group_name}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap font-bold text-slate-800">{cred.client_name}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-600">
                      {cred.url ? (
                        <a href={cred.url.startsWith('http') ? cred.url : `http://${cred.url}`} target="_blank" rel="noreferrer" className="text-wedo-blue hover:underline">
                          {cred.url}
                        </a>
                      ) : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-700">
                      {cred.username || '-'}
                      {cred.username && (
                        <button onClick={() => copyToClipboard(cred.username)} className="ml-2 text-slate-400 hover:text-wedo-orange" title="Copiar Usuario">
                          <Copy size={14} />
                        </button>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm bg-slate-100 px-2 py-1 rounded text-slate-700">
                          {visiblePasswords[cred.client_name] ? cred.password : '••••••••'}
                        </span>
                        <button onClick={() => togglePasswordVisibility(cred.client_name)} className="text-slate-400 hover:text-slate-700 p-1" title="Mostrar/Ocultar">
                          {visiblePasswords[cred.client_name] ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                        <button onClick={() => copyToClipboard(cred.password)} className="text-slate-400 hover:text-wedo-orange p-1" title="Copiar Contraseña">
                          <Copy size={14} />
                        </button>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => openEditModal(cred)} className="p-1.5 text-wedo-text hover:text-wedo-orange hover:bg-orange-50 rounded transition-colors" title="Editar">
                          <Edit2 size={16} />
                        </button>
                        <button onClick={() => handleDelete(cred.client_name)} className="p-1.5 text-wedo-text hover:text-wedo-danger hover:bg-red-50 rounded transition-colors" title="Eliminar">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="6" className="px-6 py-12 text-center text-wedo-text font-medium">
                    {searchQuery ? 'No se encontraron credenciales para tu búsqueda.' : 'No hay credenciales registradas. Haz clic en "Nueva Credencial" para comenzar.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal Agregar/Editar */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <h3 className="font-bold text-slate-800 text-lg flex items-center gap-2">
                <Key className="text-wedo-orange" size={20} />
                {editingCred ? 'Editar Credencial' : 'Nueva Credencial'}
              </h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-700 transition-colors">
                <X size={20} />
              </button>
            </div>
            
            <form onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
              {errorMsg && (
                <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm border border-red-100 font-medium">
                  {errorMsg}
                </div>
              )}
              
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">Cliente</label>
                <select 
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-wedo-orange focus:border-transparent transition-shadow disabled:opacity-60"
                  value={clientName}
                  onChange={e => setClientName(e.target.value)}
                  disabled={editingCred !== null}
                  required
                >
                  <option value="" disabled>Selecciona un cliente</option>
                  {allClients.map(c => (
                    <option key={c.name} value={c.name}>{c.name}</option>
                  ))}
                </select>
                {editingCred && <p className="text-xs text-slate-500 mt-1">El cliente no se puede cambiar en edición.</p>}
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">URL / IP de Acceso</label>
                <input 
                  type="text" 
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-wedo-orange focus:border-transparent transition-shadow"
                  placeholder="ej. 192.168.1.1 o https://router.local"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1.5">Usuario</label>
                  <input 
                    type="text" 
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-wedo-orange focus:border-transparent transition-shadow"
                    placeholder="admin"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-1.5">Contraseña</label>
                  <input 
                    type="text" 
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-wedo-orange focus:border-transparent transition-shadow"
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">Notas Adicionales</label>
                <textarea 
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-wedo-orange focus:border-transparent transition-shadow resize-none h-20"
                  placeholder="Instrucciones, puertos especiales, etc."
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                />
              </div>
              
              <div className="flex justify-end gap-3 mt-2">
                <button 
                  type="button" 
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-slate-600 hover:bg-slate-100 font-medium rounded-lg transition-colors"
                >
                  Cancelar
                </button>
                <button 
                  type="submit" 
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-wedo-orange hover:bg-wedo-orange/90 text-white font-medium rounded-lg transition-colors flex items-center gap-2 disabled:opacity-70"
                >
                  <Save size={18} />
                  {isSubmitting ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
