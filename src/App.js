import React, { Component } from 'react';
import Home from './Components/Home/Home.js'
import { HashRouter, Route, Switch } from 'react-router-dom';
import './App.css';

class App extends Component {

  trigger = () => {
    document.querySelector('#u2').value = '';
    document.querySelector('#u3').value = '';
    document.querySelector('#u4').value = '';
  }

  render() {
    return (
      <HashRouter>
        <Switch>
          <Route path='/' component={() => { return( <Home trigger={this.trigger} /> ) } } exact />
          <Route path='/play' component={() => { window.location = 'https://flai-api.herokuapp.com/play'; return null; } } />
          <Route path='/link' component={() => { window.location = 'https://flai-api.herokuapp.com/link'; return null; } } />
          <Route component={() => { return (<h1 style={{ textAlign: 'center', paddingTop: '40vh' }}>Error 404: Not Found!</h1>) }} />
        </Switch>
      </HashRouter>
    );
  }
}

export default App;
