import { useEffect, useState } from 'react'

import './App.css'
type Team = {
  id: number
  name: string
  created_at: string
}

function App() {
  const [teams, setTeams] = useState<Team[]>([])
  const loadTeams = () => {
    fetch('/api/teams')
      .then((response) => response.json())
      .then((data) => {
        console.log('Teams from API:', data)
        setTeams(data)
      })
  }
  useEffect(() => {
    console.log('Effect START')

    loadTeams()

    const interval = setInterval(() => {
      console.log('Polling tick:', new Date().toLocaleTimeString())
      loadTeams()
    }, 5000)

    return () => {
      console.log('Effect CLEANUP')
      clearInterval(interval)
    }
  }, [])

  return (
    <main>
      <h1>Team Beacon</h1>
      <h2>Teams</h2>
      <button type="button" onClick={loadTeams}>
        Refresh
      </button>
      {teams.length === 0 ? (
        <p>No teams yet.</p>
      ) : (
        <ul>
          {teams.map((team) => (
            <li key={team.id}>{team.name}</li>
          ))}
        </ul>
      )}
    </main>
  )
}

export default App
